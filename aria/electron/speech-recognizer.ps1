# JARVIS Windows Speech Recognition bridge.
# Runs continuous free-form dictation via .NET's System.Speech and streams
# newline-delimited JSON events to stdout for the Electron main process to
# relay to the renderer. Used only inside the packaged/dev Electron app,
# where the browser's own SpeechRecognition API is unavailable (Electron's
# Chromium build has no proprietary Google speech backend).

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Speech

  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $recognizer.SetInputToDefaultAudioDevice()
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
} catch {
  $json = (@{ type = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress)
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  exit 1
}

Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -Action {
  $result = $Event.SourceEventArgs.Result
  $text = $result.Text
  if ($text) {
    $alts = @()
    try {
      $alts = @($result.Alternates | Select-Object -First 3 -ExpandProperty Text | Where-Object { $_ -and $_ -ne $text })
    } catch {
      $alts = @()
    }
    $json = (@{ type = 'final'; text = $text; alternatives = $alts } | ConvertTo-Json -Compress)
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
} | Out-Null

Register-ObjectEvent -InputObject $recognizer -EventName SpeechHypothesized -Action {
  $text = $Event.SourceEventArgs.Result.Text
  if ($text) {
    $json = (@{ type = 'interim'; text = $text } | ConvertTo-Json -Compress)
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
} | Out-Null

$readyJson = (@{ type = 'ready' } | ConvertTo-Json -Compress)
[Console]::Out.WriteLine($readyJson)
[Console]::Out.Flush()

$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

# Keep the process (and its registered event subscriptions) alive until
# the parent Electron process kills it.
while ($true) {
  Start-Sleep -Seconds 1
}
