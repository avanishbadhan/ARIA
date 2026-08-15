import { el, state } from './state.js';
import { log } from './log.js';
import { speak } from './audio.js';
import { resumeListening } from './speech.js';
import { toggleCamera, captureCameraFrame } from './camera.js';
import { addTimer, addAlarm, controlStopwatch } from './widgets.js';
import { displayDiagram, displayImage } from './visual-panel.js';

const MODEL_FALLBACK_CHAIN = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
];

const TOOL_DECLARATIONS = [{
    function_declarations: [
        {
            name: "open_app",
            description: "Launches a desktop application on the target machine.",
            parameters: {
                type: "OBJECT",
                properties: {
                    app_name: {
                        type: "STRING",
                        enum: ["spotify", "steam", "xbox", "discord"],
                        description: "The targeted application to open."
                    }
                },
                required: ["app_name"]
            }
        },
        {
            name: "control_camera",
            description: "Opens, closes, or toggles the optical camera feed.",
            parameters: {
                type: "OBJECT",
                properties: {
                    action: {
                        type: "STRING",
                        enum: ["open", "close", "toggle"],
                        description: "Action to perform on the camera stream."
                    }
                },
                required: ["action"]
            }
        },
        {
            name: "set_timer",
            description: "Sets a countdown timer in seconds.",
            parameters: { type: "OBJECT", properties: { seconds: { type: "NUMBER" }, label: { type: "STRING" } }, required: ["seconds"] }
        },
        {
            name: "set_alarm",
            description: "Sets an alarm for a specific time.",
            parameters: { type: "OBJECT", properties: { time: { type: "STRING" }, label: { type: "STRING" } }, required: ["time"] }
        },
        {
            name: "control_stopwatch",
            description: "Controls the stopwatch.",
            parameters: { type: "OBJECT", properties: { action: { type: "STRING", enum: ["start", "stop", "reset"] } }, required: ["action"] }
        },
        {
            name: "render_diagram",
            description: "Renders a Mermaid.js diagram or flowchart on screen.",
            parameters: {
                type: "OBJECT",
                properties: {
                    mermaid_code: { type: "STRING", description: "Valid Mermaid.js diagram syntax (e.g. 'graph TD; A[Start] --> B[End];')" },
                    title: { type: "STRING", description: "Title of diagram" }
                },
                required: ["mermaid_code"]
            }
        },
        {
            name: "show_image",
            description: "Fetches and displays an image or schematic on the HUD.",
            parameters: {
                type: "OBJECT",
                properties: {
                    query: { type: "STRING", description: "Search query for the image or topic" }
                },
                required: ["query"]
            }
        }
    ]
}];

function buildSystemPrompt() {
    const currentTimeStr = new Date().toLocaleString();
    return `You are J.A.R.V.I.S., an extraordinarily intelligent, concise, and loyal AI assistant.
Current Time: ${currentTimeStr}
Coordinates: ${state.userLocationString}
Capabilities:
- Visual Processing: Inspect and describe image attachments passed alongside messages.
- Launch local applications (spotify, steam, xbox, discord) via tool call 'open_app'.
- Control camera feed (open, close, toggle) via tool call 'control_camera'.
- Timers, alarms, and stopwatches via tool calls.
- Diagrams: Use tool 'render_diagram' with standard Mermaid syntax whenever asked to draw or generate flowcharts.
- Images: Use tool 'show_image' when asked to display or show an image/schematic.
Keep spoken text under 2 sentences. No markdown asterisks.`;
}

async function executeLocalTool(toolCall) {
    const name = toolCall.name;
    const args = toolCall.args || {};

    if (name === "open_app") {
        const targetApp = (args.app_name || "").toLowerCase();
        const appSchemes = {
            spotify: "spotify:",
            steam: "steam:",
            xbox: "xbox:",
            discord: "discord:"
        };

        if (appSchemes[targetApp]) {
            window.location.href = appSchemes[targetApp];
            return `Launching ${targetApp.toUpperCase()}...`;
        }
        return `Application ${targetApp} is not configured.`;
    }

    if (name === "control_camera") {
        const action = args.action || "toggle";
        if (action === "open") return await toggleCamera(true);
        if (action === "close") return await toggleCamera(false);
        return await toggleCamera();
    }

    if (name === "set_timer") {
        return addTimer(args.seconds || 0, args.label || "Timer");
    }

    if (name === "set_alarm") {
        return addAlarm(args.time, args.label || "Alarm");
    }

    if (name === "control_stopwatch") {
        return controlStopwatch(args.action);
    }

    if (name === "render_diagram") {
        const title = args.title || "Diagram";
        displayDiagram(args.mermaid_code);
        return `Diagram rendered on HUD for ${title}.`;
    }

    if (name === "show_image") {
        displayImage(args.query);
        return `Displaying visual schematic for ${args.query}.`;
    }

    return "Command executed.";
}

export async function processUserCommand(command) {
    const rawKey = el.apiKeyInput.value.trim();
    if (!rawKey) return;

    const now = Date.now();
    if (now - state.lastCallTime < 2500) return;
    state.lastCallTime = now;

    state.isProcessing = true;
    try { state.recognition.stop(); } catch (e) {}

    log("You", command, "user-log");
    el.statusDisplay.innerText = "PROCESSING...";
    el.core.className = "ring core thinking";

    const userParts = [{ text: command }];

    if (el.cameraPanel.classList.contains('active')) {
        const base64Image = captureCameraFrame();
        if (base64Image) {
            userParts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: base64Image
                }
            });
            log("J.A.R.V.I.S.", "[Visual frame captured for analysis]", "jarvis-log");
        }
    }

    state.chatHistory.push({ role: "user", parts: userParts });
    if (state.chatHistory.length > 20) state.chatHistory = state.chatHistory.slice(-20);

    const systemPrompt = buildSystemPrompt();

    let success = false;
    for (const model of MODEL_FALLBACK_CHAIN) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(rawKey)}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    tools: TOOL_DECLARATIONS,
                    contents: state.chatHistory
                })
            });

            if (response.status === 404 || response.status === 429) continue;

            const data = await response.json();
            if (response.ok && data.candidates && data.candidates[0]) {
                const candidatePart = data.candidates[0].content.parts[0];

                if (candidatePart.functionCall) {
                    const resultMsg = await executeLocalTool(candidatePart.functionCall);
                    state.chatHistory.push({ role: "model", parts: [{ functionCall: candidatePart.functionCall }] });
                    log("J.A.R.V.I.S.", resultMsg, "jarvis-log");
                    speak(resultMsg, () => { resumeListening(); });
                    success = true;
                    break;
                } else if (candidatePart.text) {
                    const reply = candidatePart.text.replace(/[*#]/g, '');
                    state.chatHistory.push({ role: "model", parts: [{ text: reply }] });
                    log("J.A.R.V.I.S.", reply, "jarvis-log");
                    speak(reply, () => { resumeListening(); });
                    success = true;
                    break;
                }
            }
        } catch (err) {
            console.error("Fetch error:", err);
        }
    }

    if (!success) {
        state.chatHistory.pop();
        log("J.A.R.V.I.S.", "Connection error or quota limit reached across fallback models.", "jarvis-log");
        speak("Connection error or rate limit reached, sir.", () => { resumeListening(); });
    }
}
