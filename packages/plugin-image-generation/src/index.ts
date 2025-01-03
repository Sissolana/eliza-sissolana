import { elizaLogger } from "@elizaos/core";
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@elizaos/core";
import { generateImage } from "@elizaos/core";

import fs from "fs";
import path from "path";
import { validateImageGenConfig } from "./environment";

export function saveBase64Image(base64Data: string, filename: string): string {
    // Create generatedImages directory if it doesn't exist
    const imageDir = path.join(process.cwd(), "generatedImages");
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    // Remove the data:image/png;base64 prefix if it exists
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, "");

    // Create a buffer from the base64 string
    const imageBuffer = Buffer.from(base64Image, "base64");

    // Create full file path
    const filepath = path.join(imageDir, `${filename}.png`);
    console.log("File path at plugin image generation", filepath);
    // Save the file
    fs.writeFileSync(filepath, imageBuffer);

    return filepath;
}

export async function saveHeuristImage(
    imageUrl: string,
    filename: string
): Promise<string> {
    const imageDir = path.join(process.cwd(), "generatedImages");
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    try {
        // Fetch image from URL
        const response = await fetch(imageUrl);
        if (!response.ok) {
            elizaLogger.error(`Failed to fetch image: ${response.statusText}`);
            elizaLogger.error("Response status:", response.status);
            // Convert headers to a plain object in a type-safe way
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });
            elizaLogger.error("Response headers:", JSON.stringify(headers));
            elizaLogger.error("Response text:", await response.text());
            throw new Error(
                `Failed to fetch image: ${response.statusText} (${response.status})`
            );
        }

        const arrayBuffer = await response.arrayBuffer();
        const imageBuffer = Buffer.from(arrayBuffer);

        // Create full file path
        const filepath = path.join(imageDir, `${filename}.png`);

        // Save the file
        fs.writeFileSync(filepath, imageBuffer);
        elizaLogger.log(`Saved image to: ${filepath}`);

        return filepath;
    } catch (error) {
        elizaLogger.error("Error in saveHeuristImage:", {
            name: error?.name,
            message: error?.message,
            stack: error?.stack,
            cause: error?.cause,
        });
        throw error;
    }
}

const imageGeneration: Action = {
    name: "GENERATE_IMAGE",
    similes: [
        "IMAGE_GENERATION",
        "IMAGE_GEN",
        "CREATE_IMAGE",
        "MAKE_PICTURE",
        "GENERATE_IMAGE",
        "GENERATE_A",
        "DRAW",
        "DRAW_A",
        "MAKE_A",
    ],
    description: "Generate an image to go along with the message.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateImageGenConfig(runtime);

        const anthropicApiKeyOk = !!runtime.getSetting("ANTHROPIC_API_KEY");
        const togetherApiKeyOk = !!runtime.getSetting("TOGETHER_API_KEY");
        const heuristApiKeyOk = !!runtime.getSetting("HEURIST_API_KEY");
        const falApiKeyOk = !!runtime.getSetting("FAL_API_KEY");
        const openAiApiKeyOk = !!runtime.getSetting("OPENAI_API_KEY");
        const veniceApiKeyOk = !!runtime.getSetting("VENICE_API_KEY");

        return (
            anthropicApiKeyOk ||
            togetherApiKeyOk ||
            heuristApiKeyOk ||
            falApiKeyOk ||
            openAiApiKeyOk ||
            veniceApiKeyOk
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: {
            width?: number;
            height?: number;
            count?: number;
            negativePrompt?: string;
            numIterations?: number;
            guidanceScale?: number;
            seed?: number;
            modelId?: string;
            jobId?: string;
        },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Composing state for message:", message);
        state = (await runtime.composeState(message)) as State;
        const userId = runtime.agentId;
        elizaLogger.log("User ID:", userId);

        const imagePrompt = message.content.text;
        elizaLogger.log("Image prompt received:", imagePrompt);

        try {
            elizaLogger.log("Generating image with prompt:", imagePrompt);
            const images = await generateImage(
                {
                    prompt: imagePrompt,
                    width: 1024,
                    height: 1024,
                    count: 1,
                },
                runtime
            );

            if (images.success && images.data && images.data.length > 0) {
                elizaLogger.log(
                    "Image generation successful, number of images:",
                    images.data.length
                );

                const results = [];
                for (let i = 0; i < images.data.length; i++) {
                    const image = images.data[i];

                    // Save the image and get filepath
                    const filename = `generated_${Date.now()}_${i}`;

                    // Choose save function based on image data format
                    const filepath = image.startsWith("http")
                        ? await saveHeuristImage(image, filename)
                        : saveBase64Image(image, filename);

                    elizaLogger.log(`Processing image ${i + 1}:`, filename);

                    const result = {
                        text: "...",
                        attachments: [
                            {
                                id: crypto.randomUUID(),
                                url: filepath,
                                title: "Generated image",
                                source: "imageGeneration",
                                description: "...",
                                text: "...",
                            },
                        ],
                    };

                    if (callback) {
                        callback(result);
                    }
                    results.push(result);
                }

                // For async/await pattern
                return {
                    success: true,
                    data: results[0]?.attachments[0]?.url,
                };
            }

            const error = new Error("Image generation failed");
            if (callback) {
                callback(undefined, error);
            }
            throw error;
        } catch (error) {
            if (callback) {
                callback(undefined, error);
            }
            throw error;
        }
    },
    examples: [
        // TODO: We want to generate images in more abstract ways, not just when asked to generate an image

        [
            {
                user: "{{user1}}",
                content: { text: "Generate an image of a cat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a cat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Generate an image of a dog" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a dog",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Create an image of a cat with a hat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a cat with a hat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Make an image of a dog with a hat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a dog with a hat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Paint an image of a cat with a hat" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's an image of a cat with a hat",
                    action: "GENERATE_IMAGE",
                },
            },
        ],
    ],
} as Action;

export const imageGenerationPlugin: Plugin = {
    name: "imageGeneration",
    description: "Generate images",
    actions: [imageGeneration],
    evaluators: [],
    providers: [],
};
