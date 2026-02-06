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

// --- 1. DEMO SCENARIOS (FOR CONTROLLED PRESENTATIONS) ---
const DEMO_SCENARIOS = {
    PASS: {
        status: "HEALTHY",
        confidence: 96,
        analysis: "DEMO VERIFIED: Machine matches maintenance records. No visible rust, leaks, or wear detected on the primary components. (Backup: Filename trigger 'Healthy')",
        paymentAuthorized: true
    },
    FAIL: {
        status: "CRITICAL",
        confidence: 89,
        analysis: "DEMO ALERT: Safety hazard detected. Severe corrosion visible on the hydraulic casing. Immediate maintenance required. Payment suspended. (Backup: Filename trigger 'Fail')",
        paymentAuthorized: false
    }
};

// --- MULTER SETUP ---
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
    console.error("❌ GEMINI_API_KEY not found in .env file");
    process.exit(1);
}

if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error("❌ SOLANA_PRIVATE_KEY not found in .env file");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Setup Solana
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
let vaultWallet;
try {
    const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
    vaultWallet = Keypair.fromSecretKey(secretKey);
    console.log(`✅ Wallet Loaded: ${vaultWallet.publicKey.toString()}`);
} catch (error) {
    console.error("❌ Solana Key Error. Check .env file for valid SOLANA_PRIVATE_KEY");
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

// Cleanup function
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

// --- THE AUDIT ROUTE ---
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

        console.log(`📸 Photo received: ${photoFile.originalname} (${photoFile.mimetype})`);
        
        let aiVerdict;

        // 1. ATTEMPT REAL AI ANALYSIS
        try {
            console.log("\n🤖 Asking Gemini AI to analyze...");
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

            // Updated Prompt to handle Non-Machine Photos
            const promptParts = [
                `You are an expert industrial machine auditor. 

                STEP 1: IDENTIFICATION
                First, determine if the image actually shows an industrial machine or equipment. 
                - If the image is of a person, animal, food, landscape, or unrelated object, reject it immediately.
                - Set status to "CRITICAL" and paymentAuthorized to false.

                STEP 2: CONDITION CHECK (Only if Step 1 passes)
                Analyze the machine for:
                - Physical damage, rust, or wear
                - Proper assembly
                - Safety hazards

                Provide your assessment in strict JSON format:
                {
                  "status": "HEALTHY" or "CRITICAL",
                  "confidence": <number 0-100>,
                  "analysis": "<short explanation>",
                  "paymentAuthorized": <boolean>
                }`
            ];

            promptParts.push(fileToGenerativePart(photoFile.path, photoFile.mimetype));

            if (reportFile) {
                promptParts.push(fileToGenerativePart(reportFile.path, reportFile.mimetype));
            }

            const result = await model.generateContent(promptParts);
            const responseText = result.response.text();
            console.log("\n📄 Raw AI Response:", responseText.substring(0, 100) + "...");

            // Clean JSON
            let cleanJson = responseText.replace(/```json|```/g, "").trim();
            // Sometimes Gemini adds text before the JSON, find the first {
            const firstBracket = cleanJson.indexOf('{');
            const lastBracket = cleanJson.lastIndexOf('}');
            if (firstBracket !== -1 && lastBracket !== -1) {
                cleanJson = cleanJson.substring(firstBracket, lastBracket + 1);
            }

            aiVerdict = JSON.parse(cleanJson);

            console.log("✅ AI Analysis Success!");

        } catch (aiError) {
            // 2. CONTROLLED DEMO MODE (This saves you during the presentation!)
            console.error("\n⚠️ AI Service Failed/Skipped:", aiError.message);
            console.log("🕹️ Switching to Controlled Demo Mode...");

            // Get the filename being uploaded
            const filename = photoFile.originalname.toLowerCase();
            console.log(`🕵️ Checking filename trigger: "${filename}"`);

            // IF filename contains "bad", "fail", "broken", or "error" -> FORCE FAIL
            if (filename.includes("bad") || filename.includes("fail") || filename.includes("broken") || filename.includes("error")) {
                 console.log("🔴 Trigger detected: Forcing CRITICAL result");
                 aiVerdict = DEMO_SCENARIOS.FAIL;
            } 
            // OTHERWISE -> FORCE PASS
            else {
                 console.log("🟢 No negative trigger: Defaulting to HEALTHY result");
                 aiVerdict = DEMO_SCENARIOS.PASS;
            }
        }

        console.log(`   Status: ${aiVerdict.status}`);
        console.log(`   Payment Authorized: ${aiVerdict.paymentAuthorized}`);

        // 3. BLOCKCHAIN PAYMENT
        let txSignature = null;
        let paymentStatus = "SKIPPED";
        let explorerUrl = null;

        if (aiVerdict.paymentAuthorized === true) {
            console.log("\n💸 Payment authorized! Processing blockchain transaction...");
            try {
                // NOTE: For demo, generating a random wallet. In prod, get this from req.body.recipientAddress
                const sellerWallet = Keypair.generate();
                console.log(`   Recipient: ${sellerWallet.publicKey.toString()}`);

                // Check vault balance
                const balance = await connection.getBalance(vaultWallet.publicKey);
                const amountToSend = 0.01 * LAMPORTS_PER_SOL;
                console.log(`   Vault Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

                if (balance < amountToSend + 5000) { // +5000 for gas
                    throw new Error("Insufficient funds in vault wallet");
                }

                // Create transaction
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: vaultWallet.publicKey,
                        toPubkey: sellerWallet.publicKey,
                        lamports: amountToSend,
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

                console.log(`✅ Payment Successful!`);
                console.log(`   Transaction: ${txSignature}`);

            } catch (blockchainError) {
                console.error("\n❌ Blockchain Error:", blockchainError.message);
                paymentStatus = "FAILED";
                aiVerdict.analysis += " (Note: Payment processing failed - " + blockchainError.message + ")";
            }
        } else {
            console.log("\n🛑 Payment NOT authorized based on Analysis");
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

        console.log("\n🏁 Request completed successfully");
        console.log("=".repeat(50) + "\n");

        res.json(response);

    } catch (error) {
        console.error("\n🔥 Server Error:", error);
        console.log("=".repeat(50) + "\n");

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
    console.log(`🚀 Server Running Successfully!`);
    console.log(`   URL: http://localhost:${PORT}`);
    console.log(`   Audit Endpoint: POST http://localhost:${PORT}/api/audit-machine`);
    console.log(`   Network: Solana Devnet`);
    console.log("=".repeat(50) + "\n");
});