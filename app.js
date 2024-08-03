import 'dotenv/config';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import cron from 'node-cron';
import axios from 'axios';

const app = express();
const prisma = new PrismaClient();
const connection = new Connection(process.env.SOLANA_NETWORK);

app.use(express.json());

// Endpoint para crear una nueva factura
app.post('/invoices', async (req, res) => {
  const { amount, webhookUrl } = req.body;

  // Crear una nueva wallet
  const payer = Keypair.generate();
  const walletAddress = payer.publicKey.toString();
  const privateKey = JSON.stringify(Array.from(payer.secretKey));

  // Guardar la factura en la base de datos
  const invoice = await prisma.invoice.create({
    data: {
      amount,
      walletAddress,
      privateKey,
      status: 'pending',
      webhookUrl
    }
  });

  // Crear un cron job para escuchar la wallet
  const cronJob = await prisma.cronJob.create({
    data: {
      invoiceId: invoice.id,
      processId: `invoice_${invoice.id}_monitoring`,
      status: 'pending'
    }
  });

  // Programar el cron job
  scheduleCronJob(cronJob.id, payer.publicKey, amount, webhookUrl, privateKey);

  delete invoice.privateKey;

  res.json(invoice);
});

function scheduleCronJob(cronJobId, payerPublicKey, amount, webhookUrl, privateKey) {
  cron.schedule('*/5 * * * * *', async () => {
    console.log(`Cron job running for invoice: ${cronJobId}`);
    const cronJob = await prisma.cronJob.findUnique({ where: { id: cronJobId } });
    if (cronJob.status === 'completed') {
      console.log(`Cron job ${cronJobId} already completed`);
      return;
    }

    const adminWallet = new PublicKey(process.env.ADMIN_WALLET);
    const accountInfo = await connection.getAccountInfo(payerPublicKey);

    if (accountInfo) {
      const balance = accountInfo.lamports / LAMPORTS_PER_SOL;
      console.log(`Current balance for ${payerPublicKey.toString()}: ${balance} SOL`);
    }

    if (accountInfo && (accountInfo.lamports / LAMPORTS_PER_SOL) >= amount) {
      // Recuperar la clave privada
      const secretKey = Uint8Array.from(JSON.parse(privateKey));
      const payer = Keypair.fromSecretKey(secretKey);

      // Crear una transacción para transferir el saldo al administrador
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: adminWallet,
          lamports: accountInfo.lamports - 5000, // Dejar algo para cubrir las fees
        })
      );

      try {
        await sendAndConfirmTransaction(connection, transaction, [payer]);

        // Actualizar el estado de la factura en la base de datos
        const invoice = await prisma.invoice.update({
          where: { id: cronJob.invoiceId },
          data: { status: 'paid' }
        });

        // Marcar el cron job como completado
        await prisma.cronJob.update({
          where: { id: cronJobId },
          data: { status: 'completed' }
        });

        // Llamar al webhook
        if (invoice.webhookUrl) {
          await axios.post(invoice.webhookUrl, {
            invoiceId: invoice.id,
            status: invoice.status,
            amount: invoice.amount,
            walletAddress: invoice.walletAddress
          });
        }

        console.log(`Invoice ${invoice.id} paid and cron job ${cronJobId} completed`);
      } catch (error) {
        console.error(`Error transferring funds for invoice ${cronJob.invoiceId}:`, error);
        if (error.logs) {
          console.error('Transaction logs:', error.logs);
        }
      }
    }
  }, {
    scheduled: true,
    name: `invoice_${cronJobId}_monitoring`
  });

  console.log(`Cron job scheduled for invoice: ${cronJobId}`);
}

// Endpoint para obtener todas las facturas
app.get('/invoices', async (req, res) => {
  const invoices = await prisma.invoice.findMany();
  res.json(invoices);
});

// Endpoint para obtener una factura por ID
app.get('/invoices/:id', async (req, res) => {
  const { id } = req.params;
  const invoice = await prisma.invoice.findUnique({ where: { id: parseInt(id) } });

  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  res.json(invoice);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
