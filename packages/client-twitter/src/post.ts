import { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    parseBooleanFromText,
    ModelProviderName,
} from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { postActionResponseFooter } from "@elizaos/core";
import { generateTweetActions } from "@elizaos/core";
import { IImageDescriptionService, ServiceType } from "@elizaos/core";
import { buildConversationThread } from "./utils.ts";
import { twitterMessageHandlerTemplate } from "./interactions.ts";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.ts";
import fs from "fs/promises";
import { UUID } from "@elizaos/core";

const twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.`;

export const twitterActionTemplate =
    `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- Highly selective engagement
- Direct mentions are priority
- Skip: low-effort content, off-topic, repetitive

Actions (respond only with tags):
[LIKE] - Resonates with interests (9.5/10)
[RETWEET] - Perfect character alignment (9/10)
[QUOTE] - Can add unique value (8/10)
[REPLY] - Memetic opportunity (9/10)

Tweet:
{{currentTweet}}

# Respond with qualifying action tags only.` + postActionResponseFooter;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(
    text: string,
    maxTweetLength: number
): string {
    if (text.length <= maxTweetLength) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", maxTweetLength) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    // If no period is found, truncate to the nearest whitespace
    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", maxTweetLength)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    // Fallback: Hard truncate and add ellipsis
    return text.slice(0, maxTweetLength - 3).trim() + "...";
}

export const generateVideo = async (prompt: string, runtime: IAgentRuntime) => {
    const API_KEY = runtime.getSetting("LUMA_API_KEY");
    const API_URL = runtime.getSetting("LUMA_API_URL");

    try {
        elizaLogger.log("Starting video generation with prompt:", prompt);

        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            elizaLogger.error("Luma API error:", {
                status: response.status,
                statusText: response.statusText,
                error: errorText,
            });
            throw new Error(
                `Luma API error: ${response.statusText} - ${errorText}`
            );
        }

        const data = await response.json();
        elizaLogger.log(
            "Generation request successful, received response:",
            data
        );

        // Poll for completion
        let status = data.status;
        let videoUrl = null;
        const generationId = data.id;

        while (status !== "completed" && status !== "failed") {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

            const statusResponse = await fetch(`${API_URL}/${generationId}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${API_KEY}`,
                    accept: "application/json",
                },
            });

            if (!statusResponse.ok) {
                const errorText = await statusResponse.text();
                elizaLogger.error("Status check error:", {
                    status: statusResponse.status,
                    statusText: statusResponse.statusText,
                    error: errorText,
                });
                throw new Error(
                    "Failed to check generation status: " + errorText
                );
            }

            const statusData = await statusResponse.json();
            elizaLogger.log("Status check response:", statusData);

            status = statusData.state;
            if (status === "completed") {
                videoUrl = statusData.assets?.video;
            }
        }

        if (status === "failed") {
            throw new Error("Video generation failed");
        }

        if (!videoUrl) {
            throw new Error("No video URL in completed response");
        }

        return {
            success: true,
            data: videoUrl,
        };
    } catch (error) {
        elizaLogger.error("Video generation error:", error);
        return {
            success: false,
            error: error.message || "Unknown error occurred",
        };
    }
};

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isProcessing: boolean = false;
    private lastProcessTime: number = 0;
    private stopProcessingActions: boolean = false;

    async start(postImmediately: boolean = false) {
        if (!this.client.profile) {
            await this.client.init();
        }

        elizaLogger.log("Starting Twitter post loop...");

        const generateNewTweetLoop = async () => {
            try {
                const lastPost = await this.runtime.cacheManager.get<{
                    timestamp: number;
                }>("twitter/" + this.twitterUsername + "/lastPost");

                elizaLogger.log("New Tweet, Last post:");

                const lastPostTimestamp = lastPost?.timestamp ?? 0; // Set to 0 if lastPost is not available
                const minMinutes =
                    parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) ||
                    90;
                const maxMinutes =
                    parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) ||
                    180;
                const randomMinutes =
                    Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                    minMinutes;
                const delay = randomMinutes * 60 * 1000;
                const nextTweetTime = lastPostTimestamp + delay;

                if (lastPostTimestamp !== 0) {
                    elizaLogger.log(
                        "Last post time stamp (local time):",
                        new Date(lastPostTimestamp).toLocaleString()
                    );
                } else {
                    elizaLogger.log("Last post time stamp:", lastPostTimestamp);
                }
                elizaLogger.log("Delay:", delay);
                elizaLogger.log(
                    "Next Tweet Time:",
                    new Date(nextTweetTime).toLocaleTimeString()
                );

                const now = Date.now();

                if (now >= nextTweetTime) {
                    const executionStart = Date.now();
                    elizaLogger.log(
                        `Tweet time reached (${Math.floor((now - nextTweetTime) / 1000)} seconds past scheduled time), generating new tweet...`
                    );
                    console.log(
                        "Post.ts line 107 generateNewTweetLoop, before generateNewTweet"
                    );
                    await this.generateNewTweet();

                    const executionEnd = Date.now();

                    // Reschedule after generating the tweet
                    const newNextTweetTime = now + delay;
                    await this.runtime.cacheManager.set(
                        "twitter/" +
                            this.runtime.getSetting("TWITTER_USERNAME") +
                            "/nextTweetTime",
                        {
                            timestamp: newNextTweetTime,
                            scheduledAt: now,
                            intervalMinutes: randomMinutes,
                            lastExecutionDuration:
                                executionEnd - executionStart,
                        }
                    );
                    const nextTime = new Date(newNextTweetTime);
                    elizaLogger.log(
                        `Next tweet scheduled for ${nextTime.toLocaleTimeString()} (in ${randomMinutes} minutes)`
                    );
                } else {
                    // Only update the schedule if we're not generating a tweet
                    await this.runtime.cacheManager.set(
                        "twitter/" +
                            this.runtime.getSetting("TWITTER_USERNAME") +
                            "/nextTweetTime",
                        {
                            timestamp: nextTweetTime,
                            scheduledAt: now,
                            intervalMinutes: randomMinutes,
                        }
                    );
                    const minutesUntilTweet = Math.ceil(
                        (nextTweetTime - now) / (60 * 1000)
                    );
                    const nextTime = new Date(nextTweetTime);
                    elizaLogger.log(
                        `Next tweet scheduled for ${nextTime.toLocaleTimeString()} (in ${minutesUntilTweet} minutes)`
                    );
                }
            } catch (error) {
                elizaLogger.error("Error in generateNewTweetLoop:", error);
            }
        };

        const processActionsLoop = async () => {
            const actionInterval =
                parseInt(this.runtime.getSetting("ACTION_INTERVAL")) || 300000; // Default to 5 minutes

            const enableActionProcessing = parseBooleanFromText(
                this.runtime.getSetting("ENABLE_ACTION_PROCESSING") ?? "false"
            );

            if (!enableActionProcessing) {
                elizaLogger.log(
                    "Action processing is disabled by configuration."
                );
                return;
            }

            this.stopProcessingActions = false;

            while (!this.stopProcessingActions) {
                try {
                    const results = await this.processTweetActions();
                    if (results) {
                        elizaLogger.log(`Processed ${results.length} tweets`);
                        elizaLogger.log(
                            `Next action processing scheduled in ${actionInterval / 1000} seconds`
                        );
                        // Wait for the full interval before next processing
                        await new Promise((resolve) =>
                            setTimeout(resolve, actionInterval)
                        );
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error in action processing loop:",
                        error
                    );
                    // Add exponential backoff on error
                    await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30s on error
                }
            }
        };

        const generateAndPostVideo = async (prompt: string) => {
            const postVideo = parseBooleanFromText(
                this.runtime.getSetting("VIDEO_GEN") ?? "false"
            );
            if (!postVideo) {
                elizaLogger.log("Posting Video is disabled by configuration.");
                return;
            }

            try {
                // Step 1: Generate the video
                const videoResult = await generateVideo(prompt, this.runtime);
                // const videoResult = {
                //         success: true,
                //         data: "https://storage.cdn-luma.com/dream_machine/b4d0291d-7597-4b7f-be03-9d63cd228cf2/1a51bf10-58f8-499e-aaaa-19a9dcdd963c_video08548976f2e1c45349a62dc3da5e90342.mp4",
                // }
                if (!videoResult.success) {
                    console.error(
                        "Failed to generate video:",
                        videoResult.error
                    );
                    return;
                }

                console.log("Video generated successfully:", videoResult.data);

                // Step 2: Download the video
                const videoUrl = videoResult.data;
                const videoResponse = await fetch(videoUrl);
                if (!videoResponse.ok) {
                    console.error(
                        "Failed to download video:",
                        videoResponse.statusText
                    );
                    return;
                }
                const contentType = videoResponse.headers.get("Content-Type");

                if (contentType === "video/mp4") {
                    console.log("The video is correctly identified as MP4.");
                } else {
                    console.error(
                        "The video is not an MP4. Content-Type:",
                        contentType
                    );
                }

                // Use arrayBuffer and convert to Buffer
                const videoArrayBuffer = await videoResponse.arrayBuffer();
                const videoBuffer = Buffer.from(videoArrayBuffer);

                const videoFileName = `generatedVideos/generated_video_${Date.now()}.mp4`;
                fs.writeFile(videoFileName, Buffer.from(videoBuffer));
                elizaLogger.log("Video saved to file:", videoFileName);

                // Step 3: Post the video to Twitter
                try {
                    // Send tweet with image using new API
                    await this.client.twitterClient.sendTweet("", undefined, [
                        { data: videoBuffer, mediaType: "video/mp4" },
                    ]);
                    //await this.sendTweet(content, newTweetContent, roomId, imageBuffer);
                    elizaLogger.log("Posted tweet with generated video:");

                    await this.runtime.cacheManager.set(
                        "twitter/" +
                            this.twitterUsername +
                            "/lastPost",
                        {
                            timestamp: Date.now(),
                        }
                    );

                } catch (error) {
                    console.error("Error sending tweet:", error);
                }
            } catch (error) {
                elizaLogger.error("Error generating or posting video:", error);
            }
        };

        const videoGen = parseBooleanFromText(
            this.runtime.getSetting("VIDEO_GEN") ?? "false"
        );

        if (videoGen) {
            const videoGenIntervalMin = parseInt(
                this.runtime.getSetting("VIDEO_GEN_INTERVAL_MIN") || "720",
                10
            ); // Default to 720 minutes (12 hours)
            const videoGenIntervalMs = videoGenIntervalMin * 60 * 1000; // Convert minutes to milliseconds
            const videoPrompt =
                "A close-up of ink dissolving into water in slow motion, forming intricate patterns before fading away.";

            // Schedule the generateAndPostVideo function to run at the specified interval
            setInterval(() => {
                generateAndPostVideo(videoPrompt);
            }, videoGenIntervalMs);
        } else {
            elizaLogger.log("Video generation is disabled by configuration.");
        }

        // Check if we should post immediately
        if (
            this.runtime.getSetting("POST_IMMEDIATELY") != null &&
            this.runtime.getSetting("POST_IMMEDIATELY") != ""
        ) {
            postImmediately = parseBooleanFromText(
                this.runtime.getSetting("POST_IMMEDIATELY")
            );
        }

        if (postImmediately) {
            await this.generateNewTweet();
        }

        // Set up the interval for generating new tweets
        const minMinutes =
            parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
        const maxMinutes =
            parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
        const randomMinutes =
            Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
            minMinutes;
        const delay = randomMinutes * 60 * 1000;

        setInterval(generateNewTweetLoop, delay);

        // Start the loop immediately
        generateNewTweetLoop();

        // Add check for ENABLE_ACTION_PROCESSING before starting the loop
        const enableActionProcessing =
            this.runtime.getSetting("ENABLE_ACTION_PROCESSING") ?? false;

        elizaLogger.log(
            "Processing actions loop enabled:",
            enableActionProcessing
        );

        if (enableActionProcessing) {
            processActionsLoop().catch((error) => {
                elizaLogger.error(
                    "Fatal error in process actions loop:",
                    error
                );
            });
        } else {
            elizaLogger.log("Action processing loop disabled by configuration");
        }
        processActionsLoop();
    }

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = runtime.getSetting("TWITTER_USERNAME");
    }

    /**
     * Convert a data URL or file path to a Buffer
     * @param input The data URL string or file path
     * @returns Buffer containing the image data
     */
    private async imageToBuffer(input: string): Promise<Buffer> {
        // Check if it's a data URL
        if (input.startsWith("data:")) {
            const matches = input.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (!matches || matches.length !== 3) {
                throw new Error("Invalid data URL");
            }
            return Buffer.from(matches[2], "base64");
        }

        // Otherwise treat it as a file path
        return fs.readFile(input);
    }

    private async sendTweet(
        cleanedContent: string,
        newTweetContent: string,
        roomId: UUID,
        imageBuffer?: Buffer
    ): Promise<void> {
        const media = imageBuffer
            ? [{ data: imageBuffer, mediaType: "image/jpeg" }]
            : undefined;

        const result = await this.client.requestQueue.add(
            async () =>
                await this.client.twitterClient.sendTweet(
                    cleanedContent,
                    undefined,
                    media
                )
        );
        const body = await result.json();
        if (!body?.data?.create_tweet?.tweet_results?.result) {
            console.error("Error sending tweet; Bad response:", body);
            return;
        }
        const tweetResult = body.data.create_tweet.tweet_results.result;

        const tweet = {
            id: tweetResult.rest_id,
            name: this.client.profile.screenName,
            username: this.client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: this.client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${this.twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;

        await this.runtime.cacheManager.set(
            `twitter/${this.client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        await this.client.cacheTweet(tweet);

        elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureParticipantInRoom(
            this.runtime.agentId,
            roomId
        );

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
                text: newTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp,
        });
    }

    private async generateNewTweet() {
        elizaLogger.log("Generating new tweet for Post");

        const generateImage =
            this.runtime.getSetting("IMAGE_GEN").toLowerCase() === "true";
        const rawChance = this.runtime.getSetting("IMAGE_GEN_CHANCE") || "30";
        const imageGenChancePercent =
            parseFloat(rawChance.replace(/[^0-9.]/g, "")) || 30;
        elizaLogger.log(
            `Image generation chance set to ${imageGenChancePercent}%`
        );

        const shouldGenerateImage =
            Math.random() <
            Math.max(0, Math.min(100, imageGenChancePercent)) / 100;
        elizaLogger.log(
            `Will ${shouldGenerateImage ? "" : "not "}generate image for this tweet`
        );

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics || "",
                        action: "TWEET",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            console.log("twitter context:\n" + context);

            elizaLogger.debug("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // First attempt to clean content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(newTweetContent);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch (error) {
                error.linted = true; // make linter happy since catch needs a variable
                // If not JSON, clean the raw content
                cleanedContent = newTweetContent
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n") // Unescape newlines
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error(
                    "Failed to extract valid content from response:",
                    {
                        rawResponse: newTweetContent,
                        attempted: "JSON parsing",
                    }
                );
                return;
            }

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(
                cleanedContent,
                parseInt(this.runtime.getSetting("MAX_TWEET_LENGTH")) ||
                    DEFAULT_MAX_TWEET_LENGTH
            );

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n");

            // Final cleaning
            cleanedContent = removeQuotes(fixNewLines(content));

            if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${cleanedContent}`
                );
                if (shouldGenerateImage) {
                    elizaLogger.info("Dry run: would have generated an image");
                }
                return;
            }

            try {
                elizaLogger.log(`Posting new tweet:\n ${cleanedContent}`);

                const name = this.runtime.character.name;

                if (generateImage && shouldGenerateImage) {
                    elizaLogger.log(`Generating image for tweet...`);
                    const imagePrompt = `Generate an image that represents this tweet: ${cleanedContent} and ${name} as main character in the image`;

                    try {
                        // Generate image using the plugin
                        const imageAction = this.runtime.plugins.find(
                            (p) => p.name === "imageGeneration"
                        )?.actions?.[0];
                        if (!imageAction?.handler) {
                            elizaLogger.error(
                                "Image generation plugin not found or handler not available"
                            );
                            return;
                        }

                        // Temporarily set modelProvider to HEURIST for image generation
                        const originalProvider =
                            this.runtime.character.modelProvider;
                        this.runtime.character.modelProvider =
                            ModelProviderName.HEURIST;

                        const imageMessage = {
                            userId: this.runtime.agentId,
                            roomId: stringToUuid("twitter_image_generation"),
                            agentId: this.runtime.agentId,
                            content: {
                                text: imagePrompt,
                                action: "GENERATE_IMAGE",
                                payload: {
                                    prompt: imagePrompt,
                                    model:
                                        this.runtime.getSetting(
                                            "HEURIST_IMAGE_MODEL"
                                        ) || "FLUX.1-dev",
                                    width: 1024,
                                    height: 1024,
                                    steps: 30,
                                },
                            },
                        };

                        try {
                            // Create state for image generation
                            const state = await this.runtime.composeState(
                                imageMessage,
                                {
                                    type: "GENERATE_IMAGE",
                                    payload: {
                                        prompt: imagePrompt,
                                        model:
                                            this.runtime.getSetting(
                                                "HEURIST_IMAGE_MODEL"
                                            ) || "FLUX.1-dev",
                                        width: 1024,
                                        height: 1024,
                                        steps: 30,
                                    },
                                }
                            );

                            const result = (await imageAction.handler(
                                this.runtime,
                                imageMessage,
                                state
                            )) as
                                | { success: boolean; data?: string }
                                | undefined;

                            // Restore original modelProvider
                            this.runtime.character.modelProvider =
                                originalProvider;

                            if (result?.success && result.data) {
                                // Convert file path or data URL to Buffer
                                elizaLogger.log("Image path:", result.data);
                                const imageBuffer = await this.imageToBuffer(
                                    result.data
                                );

                                elizaLogger.log(
                                    "Image Buffer Length:",
                                    imageBuffer.length
                                );
                                elizaLogger.log(
                                    "Image Buffer Type:",
                                    typeof imageBuffer
                                );

                                // Send tweet with image using new API
                                await this.client.twitterClient.sendTweet(
                                    content,
                                    undefined,
                                    [
                                        {
                                            data: imageBuffer,
                                            mediaType: "image/png",
                                        },
                                    ]
                                );
                                //await this.sendTweet(content, newTweetContent, roomId, imageBuffer);
                                elizaLogger.log(
                                    "Posted tweet with generated image:",
                                    content
                                );
                            } else {
                                // Fallback to text-only tweet if image generation fails
                                //await this.client.twitterClient.sendTweet(content);
                                await this.sendTweet(
                                    cleanedContent,
                                    newTweetContent,
                                    roomId
                                );
                                elizaLogger.log(
                                    "Posted text-only tweet (image generation failed):",
                                    content
                                );
                            }
                        } catch (error) {
                            // Restore original modelProvider in case of error
                            this.runtime.character.modelProvider =
                                originalProvider;
                            elizaLogger.error("Error details:", {
                                name: error?.name,
                                message: error?.message,
                                stack: error?.stack,
                                cause: error?.cause,
                            });
                            throw error;
                        }
                    } catch (error) {
                        // Fallback to text-only tweet if image generation fails
                        elizaLogger.error("Error generating image:", {
                            name: error?.name,
                            message: error?.message,
                            stack: error?.stack,
                            cause: error?.cause,
                        });
                        //await this.client.twitterClient.sendTweet(content);
                        // Call the sendTweet method for text-only tweet
                        await this.sendTweet(
                            cleanedContent,
                            newTweetContent,
                            roomId
                        );
                        elizaLogger.log(
                            "Posted text-only tweet (after image error):",
                            content
                        );
                    }
                } else {
                    // Post text-only tweet
                    //await this.client.twitterClient.sendTweet(content);

                    // Call the sendTweet method in the original location
                    await this.sendTweet(
                        cleanedContent,
                        newTweetContent,
                        roomId
                    );
                    elizaLogger.log("Posted tweet:", content);
                }

                await this.runtime.cacheManager.set(
                    "twitter/" +
                        this.runtime.getSetting("TWITTER_USERNAME") +
                        "/lastPost",
                    {
                        timestamp: Date.now(),
                    }
                );
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }

    /**
     * Post a tweet with one or more images
     * @param text The tweet text
     * @param images Array of image data as Buffer or data URL strings
     * @param replyToTweetId Optional tweet ID to reply to
     */
    async postTweetWithImages(
        text: string,
        images: (Buffer | string)[],
        replyToTweetId?: string
    ) {
        try {
            // Convert any data URLs to Buffers
            const imageBuffers = await Promise.all(
                images.map(async (img) => {
                    if (Buffer.isBuffer(img)) {
                        return img;
                    }
                    if (typeof img === "string" && img.startsWith("data:")) {
                        return await this.imageToBuffer(img);
                    }
                    throw new Error(
                        "Invalid image format. Must be Buffer or data URL string."
                    );
                })
            );

            const imageData = imageBuffers.map((buffer) => ({
                data: buffer,
                mediaType: "image/jpeg", // Assuming JPEG format, adjust if needed
            }));

            await this.client.twitterClient.sendTweet(
                text,
                replyToTweetId,
                imageData
            );
            elizaLogger.log("Posted tweet with custom images:", text);
        } catch (error) {
            elizaLogger.error("Error posting tweet with images:", error);
            throw error;
        }
    }

    private async generateTweetContent(
        tweetState: any,
        options?: {
            template?: string;
            context?: string;
        }
    ): Promise<string> {
        const context = composeContext({
            state: tweetState,
            template:
                options?.template ||
                this.runtime.character.templates?.twitterPostTemplate ||
                twitterPostTemplate,
        });

        const response = await generateText({
            runtime: this.runtime,
            context: options?.context || context,
            modelClass: ModelClass.SMALL,
        });
        console.log("generate tweet content response:\n" + response);

        // First clean up any markdown and newlines
        const cleanedResponse = response
            .replace(/```json\s*/g, "") // Remove ```json
            .replace(/```\s*/g, "") // Remove any remaining ```
            .replaceAll(/\\n/g, "\n")
            .trim();

        // Try to parse as JSON first
        try {
            const jsonResponse = JSON.parse(cleanedResponse);
            if (jsonResponse.text) {
                return this.trimTweetLength(jsonResponse.text);
            }
            if (typeof jsonResponse === "object") {
                const possibleContent =
                    jsonResponse.content ||
                    jsonResponse.message ||
                    jsonResponse.response;
                if (possibleContent) {
                    return this.trimTweetLength(possibleContent);
                }
            }
        } catch (error) {
            error.linted = true; // make linter happy since catch needs a variable

            // If JSON parsing fails, treat as plain text
            elizaLogger.debug("Response is not JSON, treating as plain text");
        }

        // If not JSON or no valid content found, clean the raw text
        return this.trimTweetLength(cleanedResponse);
    }

    // Helper method to ensure tweet length compliance
    private trimTweetLength(text: string, maxLength: number = 280): string {
        if (text.length <= maxLength) return text;

        // Try to cut at last sentence
        const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
        if (lastSentence > 0) {
            return text.slice(0, lastSentence + 1).trim();
        }

        // Fallback to word boundary
        return (
            text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "..."
        );
    }

    private async processTweetActions() {
        if (this.isProcessing) {
            elizaLogger.log("Already processing tweet actions, skipping");
            return null;
        }

        try {
            this.isProcessing = true;
            this.lastProcessTime = Date.now();

            elizaLogger.log("Processing tweet actions");

            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.twitterUsername,
                this.runtime.character.name,
                "twitter"
            );

            const homeTimeline = await this.client.fetchTimelineForActions(15);
            const results = [];

            for (const tweet of homeTimeline) {
                try {
                    // Skip if we've already processed this tweet
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );
                    if (memory) {
                        elizaLogger.log(
                            `Already processed tweet ID: ${tweet.id}`
                        );
                        continue;
                    }

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const tweetState = await this.runtime.composeState(
                        {
                            userId: this.runtime.agentId,
                            roomId,
                            agentId: this.runtime.agentId,
                            content: { text: "", action: "" },
                        },
                        {
                            twitterUserName: this.twitterUsername,
                            currentTweet: `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})\nText: ${tweet.text}`,
                        }
                    );

                    const actionContext = composeContext({
                        state: tweetState,
                        template:
                            this.runtime.character.templates
                                ?.twitterActionTemplate ||
                            twitterActionTemplate,
                    });

                    const actionResponse = await generateTweetActions({
                        runtime: this.runtime,
                        context: actionContext,
                        modelClass: ModelClass.SMALL,
                    });

                    if (!actionResponse) {
                        elizaLogger.log(
                            `No valid actions generated for tweet ${tweet.id}`
                        );
                        continue;
                    }

                    const executedActions: string[] = [];

                    // Execute actions
                    if (actionResponse.like) {
                        try {
                            await this.client.twitterClient.likeTweet(tweet.id);
                            executedActions.push("like");
                            elizaLogger.log(`Liked tweet ${tweet.id}`);
                        } catch (error) {
                            elizaLogger.error(
                                `Error liking tweet ${tweet.id}:`,
                                error
                            );
                        }
                    }

                    if (actionResponse.retweet) {
                        try {
                            await this.client.twitterClient.retweet(tweet.id);
                            executedActions.push("retweet");
                            elizaLogger.log(`Retweeted tweet ${tweet.id}`);
                        } catch (error) {
                            elizaLogger.error(
                                `Error retweeting tweet ${tweet.id}:`,
                                error
                            );
                        }
                    }

                    if (actionResponse.quote) {
                        try {
                            // Build conversation thread for context
                            const thread = await buildConversationThread(
                                tweet,
                                this.client
                            );
                            const formattedConversation = thread
                                .map(
                                    (t) =>
                                        `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
                                )
                                .join("\n\n");

                            // Generate image descriptions if present
                            const imageDescriptions = [];
                            if (tweet.photos?.length > 0) {
                                elizaLogger.log(
                                    "Processing images in tweet for context"
                                );
                                for (const photo of tweet.photos) {
                                    const description = await this.runtime
                                        .getService<IImageDescriptionService>(
                                            ServiceType.IMAGE_DESCRIPTION
                                        )
                                        .describeImage(photo.url);
                                    imageDescriptions.push(description);
                                }
                            }

                            // Handle quoted tweet if present
                            let quotedContent = "";
                            if (tweet.quotedStatusId) {
                                try {
                                    const quotedTweet =
                                        await this.client.twitterClient.getTweet(
                                            tweet.quotedStatusId
                                        );
                                    if (quotedTweet) {
                                        quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
                                    }
                                } catch (error) {
                                    elizaLogger.error(
                                        "Error fetching quoted tweet:",
                                        error
                                    );
                                }
                            }

                            // Compose rich state with all context
                            const enrichedState =
                                await this.runtime.composeState(
                                    {
                                        userId: this.runtime.agentId,
                                        roomId: stringToUuid(
                                            tweet.conversationId +
                                                "-" +
                                                this.runtime.agentId
                                        ),
                                        agentId: this.runtime.agentId,
                                        content: {
                                            text: tweet.text,
                                            action: "QUOTE",
                                        },
                                    },
                                    {
                                        twitterUserName: this.twitterUsername,
                                        currentPost: `From @${tweet.username}: ${tweet.text}`,
                                        formattedConversation,
                                        imageContext:
                                            imageDescriptions.length > 0
                                                ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                                                : "",
                                        quotedContent,
                                    }
                                );

                            const quoteContent =
                                await this.generateTweetContent(enrichedState, {
                                    template:
                                        this.runtime.character.templates
                                            ?.twitterMessageHandlerTemplate ||
                                        twitterMessageHandlerTemplate,
                                });

                            if (!quoteContent) {
                                elizaLogger.error(
                                    "Failed to generate valid quote tweet content"
                                );
                                return;
                            }

                            elizaLogger.log(
                                "Generated quote tweet content:",
                                quoteContent
                            );

                            // Send the tweet through request queue
                            const result = await this.client.requestQueue.add(
                                async () =>
                                    await this.client.twitterClient.sendQuoteTweet(
                                        quoteContent,
                                        tweet.id
                                    )
                            );

                            const body = await result.json();

                            if (
                                body?.data?.create_tweet?.tweet_results?.result
                            ) {
                                elizaLogger.log(
                                    "Successfully posted quote tweet"
                                );
                                executedActions.push("quote");

                                // Cache generation context for debugging
                                await this.runtime.cacheManager.set(
                                    `twitter/quote_generation_${tweet.id}.txt`,
                                    `Context:\n${enrichedState}\n\nGenerated Quote:\n${quoteContent}`
                                );
                            } else {
                                elizaLogger.error(
                                    "Quote tweet creation failed:",
                                    body
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                "Error in quote tweet generation:",
                                error
                            );
                        }
                    }

                    if (actionResponse.reply) {
                        try {
                            await this.handleTextOnlyReply(
                                tweet,
                                tweetState,
                                executedActions
                            );
                        } catch (error) {
                            elizaLogger.error(
                                `Error replying to tweet ${tweet.id}:`,
                                error
                            );
                        }
                    }

                    // Add these checks before creating memory
                    await this.runtime.ensureRoomExists(roomId);
                    await this.runtime.ensureUserExists(
                        stringToUuid(tweet.userId),
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );
                    await this.runtime.ensureParticipantInRoom(
                        this.runtime.agentId,
                        roomId
                    );

                    // Then create the memory
                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: stringToUuid(tweet.userId),
                        content: {
                            text: tweet.text,
                            url: tweet.permanentUrl,
                            source: "twitter",
                            action: executedActions.join(","),
                        },
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp * 1000,
                    });

                    results.push({
                        tweetId: tweet.id,
                        parsedActions: actionResponse,
                        executedActions,
                    });
                } catch (error) {
                    elizaLogger.error(
                        `Error processing tweet ${tweet.id}:`,
                        error
                    );
                    continue;
                }
            }

            return results; // Return results array to indicate completion
        } catch (error) {
            elizaLogger.error("Error in processTweetActions:", error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    private async handleTextOnlyReply(
        tweet: Tweet,
        tweetState: any,
        executedActions: string[]
    ) {
        try {
            // Build conversation thread for context
            const thread = await buildConversationThread(tweet, this.client);
            const formattedConversation = thread
                .map(
                    (t) =>
                        `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
                )
                .join("\n\n");

            // Generate image descriptions if present
            const imageDescriptions = [];
            if (tweet.photos?.length > 0) {
                elizaLogger.log("Processing images in tweet for context");
                for (const photo of tweet.photos) {
                    const description = await this.runtime
                        .getService<IImageDescriptionService>(
                            ServiceType.IMAGE_DESCRIPTION
                        )
                        .describeImage(photo.url);
                    imageDescriptions.push(description);
                }
            }

            // Handle quoted tweet if present
            let quotedContent = "";
            if (tweet.quotedStatusId) {
                try {
                    const quotedTweet =
                        await this.client.twitterClient.getTweet(
                            tweet.quotedStatusId
                        );
                    if (quotedTweet) {
                        quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
                    }
                } catch (error) {
                    elizaLogger.error("Error fetching quoted tweet:", error);
                }
            }

            // Compose rich state with all context
            const enrichedState = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: { text: tweet.text, action: "" },
                },
                {
                    twitterUserName: this.twitterUsername,
                    currentPost: `From @${tweet.username}: ${tweet.text}`,
                    formattedConversation,
                    imageContext:
                        imageDescriptions.length > 0
                            ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                            : "",
                    quotedContent,
                }
            );

            // Generate and clean the reply content
            const replyText = await this.generateTweetContent(enrichedState, {
                template:
                    this.runtime.character.templates
                        ?.twitterMessageHandlerTemplate ||
                    twitterMessageHandlerTemplate,
            });

            if (!replyText) {
                elizaLogger.error("Failed to generate valid reply content");
                return;
            }

            elizaLogger.debug("Final reply text to be sent:", replyText);

            // Send the tweet through request queue
            const result = await this.client.requestQueue.add(
                async () =>
                    await this.client.twitterClient.sendTweet(
                        replyText,
                        tweet.id
                    )
            );

            const body = await result.json();

            if (body?.data?.create_tweet?.tweet_results?.result) {
                elizaLogger.log("Successfully posted reply tweet");
                executedActions.push("reply");

                // Cache generation context for debugging
                await this.runtime.cacheManager.set(
                    `twitter/reply_generation_${tweet.id}.txt`,
                    `Context:\n${enrichedState}\n\nGenerated Reply:\n${replyText}`
                );
            } else {
                elizaLogger.error("Tweet reply creation failed:", body);
            }
        } catch (error) {
            elizaLogger.error("Error in handleTextOnlyReply:", error);
        }
    }

    async stop() {
        this.stopProcessingActions = true;
    }
}
