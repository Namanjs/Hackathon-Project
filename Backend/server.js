import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, clusterApiUrl, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

// Setup Solana(The Vault)
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// Load wallet
let vaultWallet;
try {
    const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
    vaultWallet = Keypair.fromSecretKey(secretKey);
    console.log(`Loaded Vault Wallet: ${vaultWallet.publicKey.toString()}`);
} catch (error) {
    console.error(" Error loading Solana Key. Check your .env file.");
    process.exit(1);
}

// --- HELPER: Convert File for Gemini ---
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: fs.readFileSync(path).toString("base64"),
            mimeType
        },
    };
}

const multiUpload = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
    { name: 'report', maxCount: 1 }
]);

app.post('/api/audit-machine', multiUpload, async (req, res) => {
    try {
        console.log("Received Audit Files:", req.files);

        // check if at least one file exists
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        // Prepare the Prompt Parts array
        const promptParts = [];

        // 1. Add the "Role" Text Prompt
        promptParts.push(`
            Role: You are a Senior Industrial Forensic Analyst.
            
            OBJECTIVE: Perform a "Delta Analysis". 
            Compare the [CURRENT EVIDENCE] (Video/Audio) against the [BENCHMARK STANDARDS] (Report).

            INPUTS:
            1. BENCHMARK REPORT: Contains the "Golden State" specs (e.g., "Motor should hum at 60Hz", "Vibration < 2mm").
            2. CURRENT EVIDENCE: The actual video/audio of the machine right now.

            STRICT RULES:
            - If the Audio contains frequencies NOT allowed in the Benchmark Report -> FAIL.
            - If the Video shows wear/tear exceeding the Benchmark tolerances -> FAIL.
            - If the Benchmark says "1000 RPM" but audio pitch suggests lower speed -> FAIL.

            OUTPUT JSON:
            {
              "status": "HEALTHY" or "CRITICAL",
              "deviation_detected": "Describe exactly how it differs from the benchmark (e.g., 'Audio is 20% louder than benchmark allows')",
              "confidence": (0-100),
              "paymentAuthorized": true/false
            }
        `);

        // 2. Attach Video (if uploaded)
        if (req.files['video']) {
            console.log("Processing Video...");
            promptParts.push(fileToGenerativePart(req.files['video'][0].path, req.files['video'][0].mimetype));
        }

        // 3. Attach Audio (if uploaded)
        if (req.files['audio']) {
            console.log("Processing Audio...");
            promptParts.push(fileToGenerativePart(req.files['audio'][0].path, req.files['audio'][0].mimetype));
        }

        // 4. Attach Report (PDF/Text) (if uploaded)
        if (req.files['report']) {
            console.log("Processing Report...");
            promptParts.push(fileToGenerativePart(req.files['report'][0].path, req.files['report'][0].mimetype));
        }

        // Ask Gemini to look at everything
        const result = await model.generateContent(promptParts);
        const responseText = result.response.text();
        const cleanJson = responseText.replace(/```json|```/g, "").trim();
        const aiVerdict = JSON.parse(cleanJson);

        // Cleanup: Delete all temp files
        Object.values(req.files).flat().forEach(file => fs.unlinkSync(file.path));

        // B. THE BLOCKCHAIN TRIGGER
        let txSignature = null;
        let paymentStatus = "SKIPPED";

        if (aiVerdict.paymentAuthorized === true) {
            console.log("Audit Passed. Releasing Funds...");
            try {
                const sellerWallet = Keypair.generate().publicKey; //new PublicKey(req.body.sellerAddress) in production this would the way of sending the funds to seller's public key
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: vaultWallet.publicKey,
                        toPubkey: sellerWallet,
                        lamports: 0.1 * LAMPORTS_PER_SOL, // hardcoded amount
                    })
                );
                txSignature = await sendAndConfirmTransaction(connection, transaction, [vaultWallet]);
                paymentStatus = "PAID";
            } catch (err) {
                console.error("Blockchain Error:", err.message);
                paymentStatus = "FAILED_NETWORK";
            }
        } else {
            console.log("Audit Failed. Funds Frozen.");
            paymentStatus = "FROZEN";
        }

        res.json({ ...aiVerdict, paymentStatus, txSignature, explorerLink: txSignature ? `https://explorer.solana.com/tx/${txSignature}?cluster=devnet` : null });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: "Audit Failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MechSure Backend running on Port ${PORT}`));