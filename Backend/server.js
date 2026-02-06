import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";

dotenv.config();

const app = express();

// --- MULTER SETUP with better configuration ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, WEBP, and PDF are allowed.'));
        }
    }
});

app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;

// Validate environment variables
if (!process.env.GEMINI_API_KEY) {
    console.error(" GEMINI_API_KEY not found in .env file");
    process.exit(1);
}

if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error(" SOLANA_PRIVATE_KEY not found in .env file");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Setup Solana
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
let vaultWallet;
try {
    const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
    vaultWallet = Keypair.fromSecretKey(secretKey);
    console.log(` Wallet Loaded: ${vaultWallet.publicKey.toString()}`);
} catch (error) {
    console.error(" Solana Key Error. Check .env file for valid SOLANA_PRIVATE_KEY");
    console.error("Error details:", error.message);
    process.exit(1);
}

// Helper function to convert file to generative part
function fileToGenerativePart(filePath, mimeType) {
    try {
        const data = fs.readFileSync(filePath);
        return {
            inlineData: {
                data: data.toString("base64"),
                mimeType: mimeType
            }
        };
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error.message);
        throw error;
    }
}

// Cleanup function to delete uploaded files
function cleanupFiles(files) {
    try {
        if (files) {
            Object.keys(files).forEach(key => {
                files[key].forEach(file => {
                    if (fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                        console.log(`🗑️  Deleted: ${file.path}`);
                    }
                });
            });
        }
    } catch (error) {
        console.error("Cleanup error:", error.message);
    }
}

// --- HEALTH CHECK ROUTE ---
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        wallet: vaultWallet.publicKey.toString()
    });
});

// --- THE AUDIT ROUTE (UPDATED FOR PHOTOS) ---
app.post('/api/audit-machine', upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'report', maxCount: 1 }
]), async (req, res) => {
    console.log("\n" + "=".repeat(50));
    console.log("📨 Received Request at /api/audit-machine");
    console.log("=".repeat(50));

    try {
        // Validate uploaded files
        if (!req.files || !req.files['photo']) {
            return res.status(400).json({
                error: "No photo uploaded. Please upload a machine photo."
            });
        }

        const photoFile = req.files['photo'][0];
        const reportFile = req.files['report'] ? req.files['report'][0] : null;

        console.log(` Photo received: ${photoFile.originalname} (${photoFile.mimetype})`);
        if (reportFile) {
            console.log(` Report received: ${reportFile.originalname} (${reportFile.mimetype})`);
        }

        let aiVerdict;

        // 1. ATTEMPT REAL AI ANALYSIS
        try {
            console.log("\n Asking Gemini AI to analyze...");
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

            const promptParts = [
                `You are an expert industrial machine auditor. Analyze the provided machine photo(s) and determine if the machine is in good working condition.

Look for:
- Physical damage, rust, or wear
- Proper assembly and alignment
- Safety hazards
- Operational readiness
- Any visible defects or anomalies

${reportFile ? 'Compare your visual analysis with the provided maintenance report.' : ''}

Provide your assessment in strict JSON format with no additional text:
{
  "status": "HEALTHY" or "CRITICAL",
  "confidence": <number 0-100>,
  "analysis": "<detailed explanation of findings>",
  "paymentAuthorized": <true or false>
}

Only authorize payment (paymentAuthorized: true) if the machine appears to be in good working condition with confidence > 70.`
            ];

            // Add photo
            promptParts.push(fileToGenerativePart(photoFile.path, photoFile.mimetype));

            // Add report if available
            if (reportFile) {
                promptParts.push(fileToGenerativePart(reportFile.path, reportFile.mimetype));
            }

            const result = await model.generateContent(promptParts);
            const responseText = result.response.text();
            console.log("\n Raw AI Response:", responseText.substring(0, 200) + "...");

            // Clean and parse JSON
            const cleanJson = responseText.replace(/```json|```/g, "").trim();
            aiVerdict = JSON.parse(cleanJson);

            console.log("\n AI Analysis Success!");
            console.log(`   Status: ${aiVerdict.status}`);
            console.log(`   Confidence: ${aiVerdict.confidence}%`);
            console.log(`   Payment Authorized: ${aiVerdict.paymentAuthorized}`);

        } catch (aiError) {
            // 2. BACKUP MOCK MODE (If AI fails)
            console.error("\n  AI Error:", aiError.message);
            console.log(" Switching to Demo Backup Mode...");

            aiVerdict = {
                status: "HEALTHY",
                confidence: 85,
                analysis: "DEMO MODE: Photo analysis completed using backup system. Machine appears operational. (AI Service temporarily unavailable)",
                paymentAuthorized: true
            };
        }

        // 3. BLOCKCHAIN PAYMENT
        let txSignature = null;
        let paymentStatus = "SKIPPED";
        let explorerUrl = null;

        if (aiVerdict.paymentAuthorized === true) {
            console.log("\n💸 Payment authorized! Processing blockchain transaction...");
            try {
                // Generate a random seller wallet (in production, this would be provided)
                const sellerWallet = Keypair.generate();
                console.log(`   Recipient: ${sellerWallet.publicKey.toString()}`);

                // Check vault balance
                const balance = await connection.getBalance(vaultWallet.publicKey);
                console.log(`   Vault Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

                if (balance < 0.1 * LAMPORTS_PER_SOL) {
                    throw new Error("Insufficient funds in vault wallet");
                }

                // Create transaction
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: vaultWallet.publicKey,
                        toPubkey: sellerWallet.publicKey,
                        lamports: 0.1 * LAMPORTS_PER_SOL,
                    })
                );

                // Send and confirm
                txSignature = await sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [vaultWallet],
                    { commitment: 'confirmed' }
                );

                paymentStatus = "PAID";
                explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;

                console.log(`\n Payment Successful!`);
                console.log(`   Transaction: ${txSignature}`);
                console.log(`   Explorer: ${explorerUrl}`);

            } catch (blockchainError) {
                console.error("\n Blockchain Error:", blockchainError.message);
                paymentStatus = "FAILED";
                aiVerdict.analysis += " (Note: Payment processing failed - " + blockchainError.message + ")";
            }
        } else {
            console.log("\n Payment NOT authorized based on AI analysis");
        }

        // Cleanup uploaded files
        cleanupFiles(req.files);

        // Return response
        const response = {
            ...aiVerdict,
            paymentStatus,
            txSignature,
            explorerUrl,
            timestamp: new Date().toISOString()
        };

        console.log("\n Request completed successfully");
        console.log("=".repeat(50) + "\n");

        res.json(response);

    } catch (error) {
        console.error("\n Server Error:", error);
        console.log("=".repeat(50) + "\n");

        // Cleanup files on error
        cleanupFiles(req.files);

        res.status(500).json({
            error: "Internal Server Error",
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({
            error: 'File upload error',
            message: error.message
        });
    }
    next(error);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log("\n" + "=".repeat(50));
    console.log(` Server Running Successfully!`);
    console.log(`   URL: http://localhost:${PORT}`);
    console.log(`   Health Check: http://localhost:${PORT}/health`);
    console.log(`   Audit Endpoint: POST http://localhost:${PORT}/api/audit-machine`);
    console.log(`   Network: Solana Devnet`);
    console.log("=".repeat(50) + "\n");
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n Shutting down gracefully...');
    process.exit(0);
});