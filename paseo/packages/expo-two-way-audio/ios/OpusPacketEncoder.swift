import AVFoundation
import Foundation

/// Streaming 16 kHz mono PCM16 -> Opus encoder built on Apple's AudioToolbox Opus codec
/// (kAudioFormatOpus, iOS 11+). No third-party library.
///
/// Output framing ("paseo-opus-len16"): each Opus packet is written as a 2-byte big-endian
/// length followed by that many packet bytes. One packet = one 20 ms Opus frame (320 samples).
/// Packets never straddle two `encode` results, so every result can be decoded on its own as
/// long as the results are fed to one decoder in order.
final class OpusPacketEncoder {
    static let frameSamples: AVAudioFrameCount = 320 // 20 ms at 16 kHz

    private let inputFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat
    private let converter: AVAudioConverter
    private var pending = Data() // PCM16LE bytes not yet fed to the converter
    private var pendingInput: AVAudioPCMBuffer?
    private let lock = NSLock()

    enum EncoderError: Error {
        case formatUnavailable
        case converterUnavailable
    }

    init(sampleRate: Double = 16000, bitRate: Int = 16000) throws {
        guard let input = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)
        else { throw EncoderError.formatUnavailable }
        var description = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: OpusPacketEncoder.frameSamples,
            mBytesPerFrame: 0,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 0,
            mReserved: 0)
        guard let output = AVAudioFormat(streamDescription: &description) else {
            throw EncoderError.formatUnavailable
        }
        guard let converter = AVAudioConverter(from: input, to: output) else {
            throw EncoderError.converterUnavailable
        }
        converter.bitRate = bitRate
        self.inputFormat = input
        self.outputFormat = output
        self.converter = converter
    }

    /// Feed PCM16LE mono samples; returns the framed packets that are complete so far
    /// (possibly empty while less than 20 ms is buffered).
    func encode(_ pcm: Data) -> Data {
        lock.lock()
        defer { lock.unlock() }
        pending.append(pcm)
        return drain(flushTail: false)
    }

    /// Pad the last partial frame with silence and return the remaining packets.
    func flush() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return drain(flushTail: true)
    }

    private func drain(flushTail: Bool) -> Data {
        let frameBytes = Int(OpusPacketEncoder.frameSamples) * 2
        if flushTail && pending.count % frameBytes != 0 {
            pending.append(Data(count: frameBytes - pending.count % frameBytes))
        }
        var out = Data()
        while pending.count >= frameBytes {
            let chunk = pending.prefix(frameBytes)
            pending.removeFirst(frameBytes)
            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: inputFormat, frameCapacity: OpusPacketEncoder.frameSamples)
            else { continue }
            buffer.frameLength = OpusPacketEncoder.frameSamples
            chunk.withUnsafeBytes { raw in
                if let base = raw.baseAddress, let dest = buffer.int16ChannelData?[0] {
                    memcpy(dest, base, frameBytes)
                }
            }
            pendingInput = buffer
            out.append(convertPending())
        }
        return out
    }

    private func convertPending() -> Data {
        var out = Data()
        while true {
            let compressed = AVAudioCompressedBuffer(
                format: outputFormat,
                packetCapacity: 4,
                maximumPacketSize: max(converter.maximumOutputPacketSize, 1500))
            var conversionError: NSError?
            let status = converter.convert(to: compressed, error: &conversionError) { _, inputStatus in
                if let buffer = self.pendingInput {
                    self.pendingInput = nil
                    inputStatus.pointee = .haveData
                    return buffer
                }
                inputStatus.pointee = .noDataNow
                return nil
            }
            if status == .error {
                return out
            }
            appendPackets(from: compressed, to: &out)
            if compressed.packetCount == 0 || pendingInput == nil && status != .haveData {
                return out
            }
        }
    }

    private func appendPackets(from buffer: AVAudioCompressedBuffer, to out: inout Data) {
        guard let descriptions = buffer.packetDescriptions else { return }
        let base = buffer.data.assumingMemoryBound(to: UInt8.self)
        for index in 0..<Int(buffer.packetCount) {
            let description = descriptions[index]
            let size = Int(description.mDataByteSize)
            guard size > 0, size <= 0xFFFF else { continue }
            out.append(UInt8((size >> 8) & 0xFF))
            out.append(UInt8(size & 0xFF))
            out.append(base.advanced(by: Int(description.mStartOffset)), count: size)
        }
    }
}
