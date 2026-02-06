import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

async function getModels() {
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        console.log("📋 AVAILABLE MODELS:");
        console.log("--------------------");
        data.models.forEach(model => {
            // Filter for only "generateContent" models (the ones you can chat with)
            if (model.supportedGenerationMethods.includes("generateContent")) {
                console.log(`Name: ${model.name.replace("models/", "")}`);
                console.log(`Desc: ${model.displayName}`);
                console.log("--------------------");
            }
        });
    } catch (error) {
        console.error("Error fetching models:", error);
    }
}

getModels();