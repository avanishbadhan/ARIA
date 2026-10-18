const WAKE_WORD_REGEX = /^(?:hey[,]?\s+)?aria\b[,!.\s]*/i;
const STOP_PHRASE_REGEX =
  /^(?:(?:hey[,]?\s+)?aria[,!.\s]*)?(?:stop(?: the)? conversation|stop(?: listening)?|end(?: the)? conversation|end|that['’]?s all|goodbye aria|goodbye)[.,!?\s]*$/i;

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

  /**
   * True when the utterance is an end-conversation phrase ("end conversation",
   * "stop", "goodbye", etc.), regardless of whether a conversation is active.
   * Used by the manual text-input path (main.js) so typed "stop"/"end
   * conversation" also end the session instead of being sent to the LLM.
   */
  isStopPhrase(text) {
    return STOP_PHRASE_REGEX.test(String(text || '').trim());
  }

  handleTranscript(text, alternatives = []) {
    // No raw-text fallback: an utterance that is ONLY the wake word strips to
    // empty, which callers use to (re)arm the command window instead of
    // dispatching the literal wake word as chat.
    const stripWake = (s) => s.replace(WAKE_WORD_REGEX, '').trim();
    const cleanedAlternatives = alternatives.map(stripWake).filter(Boolean);
    const wakeMatch = text.match(WAKE_WORD_REGEX);

    // End-conversation phrases end an active conversation, and also end a
    // just-addressed one ("Hey Aria, stop"). While idle with no wake word,
    // a bare "stop conversation" is ignored (ambient speech, not addressed to
    // ARIA) so passive listening doesn't react to background chatter.
    if ((this._conversationActive || this._awaitingCommand || wakeMatch) && this.isStopPhrase(text)) {
      this._conversationActive = false;
      this._awaitingCommand = false;
      return { action: 'END_CONVERSATION' };
    }

    const command = stripWake(text);
    if (!command && (this._conversationActive || this._awaitingCommand)) {
      // Bare wake word ("Aria.") mid-conversation or while already awaiting:
      // re-arm the command window instead of dispatching "Aria" as chat.
      this._conversationActive = false;
      this._awaitingCommand = true;
      return { action: 'AWAIT_COMMAND' };
    }

    if (this._conversationActive) {
      return { action: 'DISPATCH_COMMAND', command, alternatives: cleanedAlternatives, conversationStarting: false, chime: false };
    }

    if (this._awaitingCommand) {
      this._awaitingCommand = false;
      this._conversationActive = true;
      return { action: 'DISPATCH_COMMAND', command, alternatives: cleanedAlternatives, conversationStarting: true, chime: false };
    }

    if (!wakeMatch) {
      return { action: 'IGNORE' };
    }

    const trailingCommand = text.slice(wakeMatch[0].length).trim();
    if (trailingCommand) {
      this._conversationActive = true;
      return { action: 'DISPATCH_COMMAND', command: trailingCommand, alternatives: cleanedAlternatives, conversationStarting: true, chime: true };
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
