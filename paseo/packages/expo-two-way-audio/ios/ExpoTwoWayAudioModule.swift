import ExpoModulesCore

let ON_MIC_DATA_EVENT_NAME = "onMicrophoneData"
let ON_INPUT_VOLUME_LEVEL_EVENT_NAME = "onInputVolumeLevelData"
let ON_OUTPUT_VOLUME_LEVEL_EVENT_NAME = "onOutputVolumeLevelData"
let ON_RECORDING_CHANGE_EVENT_NAME = "onRecordingChange"
let ON_AUDIO_INTERRUPTION_EVENT_NAME = "onAudioInterruption"

public class ExpoTwoWayAudioModule: Module {
    private var audioEngine: AudioEngine?
    // Dictation Opus encoders by handle. JS owns the lifetime (create -> encode* -> flush ->
    // release); tearDown drops any left over.
    private var opusEncoders: [Int: OpusPacketEncoder] = [:]
    private var nextOpusEncoderId = 1
    private let opusEncodersLock = NSLock()
    public func definition() -> ModuleDefinition {
        Name("ExpoTwoWayAudio")

        OnCreate {
            let permissionsManager = self.appContext?.permissions
            EXPermissionsMethodsDelegate.register(
                [
                    MicrophonePermissionRequester()
                ],
                withPermissionsManager: permissionsManager
            )

        }

        AsyncFunction("initialize") { () -> Bool in
            do {
                if self.audioEngine != nil {
                    return true
                }
                self.audioEngine = try AudioEngine()
                self.setupMicrophoneCallback()
                self.setupInputAudioLevelCallback()
                self.setupOutputAudioLevelCallback()
                self.setupAudioInterruptionCallback()
                return true
            } catch {
                print("Failed to initialize AudioEngine: \(error)")
                return false
            }
        }

        // Safety net for the JS-driven release in `stopCapture`/`processQueue`: never leave
        // the non-mixing `.playAndRecord` session active while backgrounded, or iOS
        // re-asserts it on the next foreground and kills the user's music again.
        OnAppEntersBackground {
            guard self.audioEngine?.isRecording == false else { return }
            self.audioEngine?.releaseAudioSession()
        }

        Function("releaseAudioSession") {
            self.audioEngine?.releaseAudioSession()
        }

        Function("isRecording") { () -> Bool in
            guard let audioEngine = self.audioEngine else {
                print("AudioEngine not initialized")
                return false
            }
            return audioEngine.isRecording
        }

        Function("toggleRecording") { (val: Bool) -> Bool in
            guard let audioEngine = self.audioEngine else {
                print("AudioEngine not initialized")
                return false
            }
            let isRecording = audioEngine.toggleRecording(val)
            self.sendEvent(
                ON_RECORDING_CHANGE_EVENT_NAME,
                [
                    "data": isRecording
                ])
            return isRecording
        }

        Function("getMicrophoneModeIOS") { () -> String in
            if #available(iOS 15.0, *) {
                let mode = AVCaptureDevice.preferredMicrophoneMode.rawValue
                var micMode = ""

                switch mode {
                case 1:
                    micMode = MicrophoneMode.wideSpectrum.rawValue
                case 2:
                    micMode = MicrophoneMode.voiceIsolation.rawValue
                default:
                    micMode = MicrophoneMode.standard.rawValue
                }
                return micMode
            }
            print("Please update your ios")

            return ""
        }

        Function("setMicrophoneModeIOS") {
            if #available(iOS 15, *) {
                if AVCaptureDevice.preferredMicrophoneMode != .voiceIsolation {
                    AVCaptureDevice.showSystemUserInterface(.microphoneModes)
                }
            } else {
                print("This code only runs on iOS 14 and lower")
            }
        }

        Function("tearDown") {
            self.audioEngine?.tearDown()
            self.audioEngine = nil
            self.opusEncodersLock.lock()
            self.opusEncoders.removeAll()
            self.opusEncodersLock.unlock()
        }

        // MARK: Dictation Opus (16 kHz mono PCM16 in, len16-framed Opus packets out).
        // See OpusPacketEncoder.swift for the framing. Returns -1 when the system codec is missing.
        Function("createOpusEncoder") { (bitRate: Int) -> Int in
            guard let encoder = try? OpusPacketEncoder(sampleRate: 16000, bitRate: bitRate) else {
                return -1
            }
            self.opusEncodersLock.lock()
            defer { self.opusEncodersLock.unlock() }
            let id = self.nextOpusEncoderId
            self.nextOpusEncoderId += 1
            self.opusEncoders[id] = encoder
            return id
        }

        Function("opusEncode") { (id: Int, pcm: Data) -> Data in
            return self.opusEncoder(id)?.encode(pcm) ?? Data()
        }

        Function("flushOpusEncoder") { (id: Int) -> Data in
            return self.opusEncoder(id)?.flush() ?? Data()
        }

        Function("releaseOpusEncoder") { (id: Int) in
            self.opusEncodersLock.lock()
            self.opusEncoders.removeValue(forKey: id)
            self.opusEncodersLock.unlock()
        }

        Function("restart") {
            self.audioEngine?.resumeRecordingAndPlayer()
            self.sendEvent(
                ON_RECORDING_CHANGE_EVENT_NAME,
                [
                    "data": audioEngine?.isRecording
                ])

        }

        Function("playPCMData") { (pcmData: Data) in
            self.audioEngine?.playPCMData(pcmData)
        }

        Function("bypassVoiceProcessing") { (bypass: Bool) in
            self.audioEngine?.bypassVoiceProcessing(bypass)
        }

        Function("isPlaying") { () -> Bool in
            return self.audioEngine?.isPlaying ?? false
        }

        Function("stopPlayback") {
            self.audioEngine?.stopPlayback()
        }

        Function("pausePlayback") {
            self.audioEngine?.pausePlayback()
        }

        Function("resumePlayback") {
            self.audioEngine?.resumePlayback()
        }

        AsyncFunction("getMicrophonePermissionsAsync") { (promise: Promise) in
            EXPermissionsMethodsDelegate.getPermissionWithPermissionsManager(
                self.appContext?.permissions,
                withRequester: MicrophonePermissionRequester.self,
                resolve: promise.resolver,
                reject: promise.legacyRejecter
            )
        }

        AsyncFunction("requestMicrophonePermissionsAsync") { (promise: Promise) in
            EXPermissionsMethodsDelegate.askForPermission(
                withPermissionsManager: self.appContext?.permissions,
                withRequester: MicrophonePermissionRequester.self,
                resolve: promise.resolver,
                reject: promise.legacyRejecter
            )
        }

        // Define the events that can be emitted
        Events([
            ON_MIC_DATA_EVENT_NAME,
            ON_INPUT_VOLUME_LEVEL_EVENT_NAME,
            ON_OUTPUT_VOLUME_LEVEL_EVENT_NAME,
            ON_RECORDING_CHANGE_EVENT_NAME,
            ON_AUDIO_INTERRUPTION_EVENT_NAME,
        ])
    }

    private func opusEncoder(_ id: Int) -> OpusPacketEncoder? {
        opusEncodersLock.lock()
        defer { opusEncodersLock.unlock() }
        return opusEncoders[id]
    }

    private func setupMicrophoneCallback() {
        audioEngine?.onMicDataCallback = { [weak self] data in
            self?.sendEvent(
                ON_MIC_DATA_EVENT_NAME,
                [
                    "data": data
                ])
        }
    }

    private func setupInputAudioLevelCallback() {
        audioEngine?.onInputVolumeCallback = { [weak self] level in
            self?.sendEvent(
                ON_INPUT_VOLUME_LEVEL_EVENT_NAME,
                [
                    "data": level
                ])
        }
    }

    private func setupOutputAudioLevelCallback() {
        audioEngine?.onOutputVolumeCallback = { [weak self] level in
            self?.sendEvent(
                ON_OUTPUT_VOLUME_LEVEL_EVENT_NAME,
                [
                    "data": level
                ])
        }
    }

    private func setupAudioInterruptionCallback() {
        audioEngine?.onAudioInterruptionCallback = { [weak self] data in
            self?.sendEvent(
                ON_AUDIO_INTERRUPTION_EVENT_NAME,
                [
                    "data": data
                ])
            self?.sendEvent(
                ON_RECORDING_CHANGE_EVENT_NAME,
                [
                    "data": self?.audioEngine?.isRecording
                ])
        }
    }

    enum MicrophoneMode: String, Enumerable {
        case standard
        case voiceIsolation
        case wideSpectrum
    }
}
