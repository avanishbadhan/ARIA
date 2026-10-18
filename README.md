# ARIA
### Adaptive Reasoning & Intelligent Automation

**Meet ARIA!** A personal AI assistant designed to see, listen, understand, and help you get things done.

ARIA combines conversational AI, voice interaction, computer vision, and software integrations into one interactive desktop application. Instead of being just another chatbot, ARIA is being built to understand your requests, interact with applications, and make everyday tasks easier.

**ARIA is currently in BETA!** We're actively developing the project, improving existing features, and working on new capabilities.

---

## What Can ARIA Do?

Here's what we've built into ARIA so far!

### AI-Powered Conversations
Talk to ARIA naturally using text or voice. ARIA supports multiple AI providers, including Google Gemini, Groq, and OpenRouter, with configurable models for different tasks.

### Voice Interaction
Speak directly to ARIA and receive spoken responses. The voice interface lets you interact with the assistant without constantly typing commands.

### Computer Vision
ARIA includes camera and screen-vision capabilities, allowing it to analyze visual information and respond to questions about what it sees.

### App & Tool Integrations
ARIA includes integrations for interacting with external applications and services:

- **Google Search & Web Browsing** — Search for information and access webpage content.
- **Gmail** — Access and interact with emails through a connected Google account.
- **Google Calendar** — View events and manage scheduling.
- **Spotify** — Open Spotify and control supported music playback.
- **Steam, Epic Games & Xbox** — Interact with supported gaming platforms and launch games.
- **WolframAlpha** — Access computational tools for mathematical queries.

Some integrations require account connections or additional API configuration.

### Everyday Utilities
ARIA also includes tools for:

- Weather information
- Location-aware searches
- Maps and directions
- Local notes and file interactions
- Time and date queries

### Interactive Desktop Interface
ARIA features a custom-designed interface that brings its different capabilities together.

The goal is to make the assistant feel responsive and intuitive, with visual feedback that makes it easier to understand what ARIA is doing.

### Modular Architecture
ARIA's functionality is divided into separate modules for AI communication, voice processing, visual input, application integrations, and tool execution.

This allows us to develop and improve individual features without rebuilding the entire application.

---

## What's Coming Next?

We have much bigger plans for ARIA! Our goal is to transform it from a conversational assistant into a persistent, context-aware system that can help across different devices and applications.

Here are some of the features we're planning:

### Persistent Memory
We want ARIA to remember useful information across sessions, including preferences, previous conversations, projects, and important context.

Rather than starting from scratch every time, ARIA would be able to build on what it already knows.

### More Advanced Automation
We're working toward an assistant that can plan and execute more complex, multi-step tasks.

Instead of only answering questions, ARIA would be able to coordinate different tools and applications to complete requests from start to finish.

### Proactive Assistance
Eventually, we want ARIA to help without always needing to be asked.

This could include recognizing upcoming deadlines, identifying schedule conflicts, monitoring relevant events, and providing reminders when something needs attention.

### Multi-Device Support
Our long-term vision is to make ARIA accessible across desktop computers, phones, and embedded devices, with the ability to carry context between them.

### Hardware Integration
We also plan to explore connecting ARIA to physical hardware, including Raspberry Pi devices, microcontrollers, cameras, and sensors.

This would allow ARIA to interact with more than just software.

### Privacy & Local AI
We want to explore local AI models and user-controlled data storage to reduce dependence on cloud services and give users more control over their information.

### Extensible Skills
We're interested in developing a modular system that makes it easier to add new capabilities and integrations as the project grows.

---

## Built With

ARIA uses a combination of web technologies, AI services, and desktop application tools.

| Technology | Purpose |
|---|---|
| JavaScript | Core application logic |
| HTML & CSS | Interface design and styling |
| Electron | Desktop application |
| Vite | Development and build tooling |
| Google Gemini | AI model integration |
| Groq | AI model integration |
| OpenRouter | Access to additional AI models |
| Browser APIs | Speech, camera, and other browser capabilities |
| Playwright & MCP | Web interaction and tool integration |

---

## Getting Started

Want to try ARIA yourself? Here's how to get it running.

### Requirements

- Node.js and npm
- A Windows computer for the desktop development workflow
- An API key for at least one supported AI provider
- Additional credentials for optional third-party integrations

### 1. Clone the Repository

```bash
git clone https://github.com/avanishbadhan/ARIA.git
cd ARIA
```

### 2. Install Dependencies

From the repository root:

```bash
npm --prefix aria install
```

### 3. Start the Development Server

```bash
npm run dev
```

The Vite development server runs at:

```text
http://localhost:3000
```

### 4. Launch the Desktop App

Keep the development server running and open a second terminal in the repository root:

```bash
npm run electron
```

ARIA should now open in its Electron desktop window.

### 5. Configure Your AI Provider

Open the application's settings and configure a supported AI provider using your own API key.

Additional integrations may require separate account connections or credentials.

**Keep your API keys private and never commit them to GitHub.**

---

## Our Vision

We're building ARIA around a simple idea: **an AI assistant should do more than just answer questions.**

We want ARIA to become an assistant that understands context, interacts with tools, remembers what's important, and eventually helps users accomplish tasks proactively.

There's still a lot we want to build, and ARIA will continue evolving as we experiment with new technologies and improve its capabilities.

---

## Developers

Built and developed by:

- **[Avanish Badhan](https://github.com/avanishbadhan)**
- **[Taksh Biyani](https://github.com/Taksh-Biyani)**
