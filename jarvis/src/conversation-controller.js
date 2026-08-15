const WAKE_WORD_REGEX = /^(?:hey[,]?\s+)?jarvis\b[,!.\s]*/i;
const STOP_PHRASE_REGEX =
  /^(?:(?:hey[,]?\s+)?jarvis[,!.\s]*)?(?:stop(?: the)? conversation|end(?: the)? conversation|that['’]?s all|goodbye jarvis)[.!]?\s*$/i;

export class ConversationController {
  constructor({ wakeTimeoutMs = 8000, conversationTimeoutMs = 120000 } = {}) {
    this.wakeTimeoutMs = wakeTimeoutMs;
    this.conversationTimeoutMs = conversationTimeoutMs;
    this._awaitingCommand = false;
    this._conversationActive = false;
  }

  get isAwaitingCommand() {
    return this._awaitingCommand;
  }

  get isConversationActive() {
    return this._conversationActive;
  }

  handleTranscript(text, alternatives = []) {
    const stripWake = (s) => s.replace(WAKE_WORD_REGEX, '').trim() || s.trim();
    const cleanedAlternatives = alternatives.map(stripWake).filter(Boolean);

    if (this._conversationActive) {
      if (STOP_PHRASE_REGEX.test(text.trim())) {
        this._conversationActive = false;
        return { action: 'END_CONVERSATION' };
      }
      const command = stripWake(text);
      return { action: 'DISPATCH_COMMAND', command, alternatives: cleanedAlternatives, conversationStarting: false, chime: false };
    }

    if (this._awaitingCommand) {
      this._awaitingCommand = false;
      this._conversationActive = true;
      const command = stripWake(text);
      return { action: 'DISPATCH_COMMAND', command, alternatives: cleanedAlternatives, conversationStarting: true, chime: false };
    }

    const wakeMatch = text.match(WAKE_WORD_REGEX);
    if (!wakeMatch) {
      return { action: 'IGNORE' };
    }

    const command = text.slice(wakeMatch[0].length).trim();
    if (command) {
      this._conversationActive = true;
      return { action: 'DISPATCH_COMMAND', command, alternatives: cleanedAlternatives, conversationStarting: true, chime: true };
    }

    this._awaitingCommand = true;
    return { action: 'AWAIT_COMMAND' };
  }

  onWakeTimeout() {
    this._awaitingCommand = false;
  }

  onConversationTimeout() {
    this._conversationActive = false;
  }

  reset() {
    this._awaitingCommand = false;
    this._conversationActive = false;
  }
}
