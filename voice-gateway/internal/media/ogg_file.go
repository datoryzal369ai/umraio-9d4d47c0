package media

// FILE-QUALITY OGG WRITER — used by the WhatsApp voice-note converter only.
//
// WriteOggOpus (call path) hardcodes a 312-sample pre-skip and derives the
// final granule from the packet count, which leaves the zero padding of the
// last frame audible and ignores the real encoder lookahead. A downloadable
// voice note needs both to be exact, so this writer takes them from the
// encoder and clamps the final page granule to the true input duration.
// The page/CRC/lacing primitives are shared; the call path is untouched.

import "encoding/binary"

func opusHeadPreSkip(channels uint8, preSkip int, inputRate uint32) []byte {
	h := make([]byte, 19)
	copy(h, "OpusHead")
	h[8] = 1
	h[9] = channels
	if preSkip < 0 {
		preSkip = 0
	}
	if preSkip > 0xffff {
		preSkip = 0xffff
	}
	binary.LittleEndian.PutUint16(h[10:], uint16(preSkip))
	binary.LittleEndian.PutUint32(h[12:], inputRate)
	return h
}

// WriteOggOpusFile packs Opus packets into a complete single-stream Ogg file.
//
//	frameSamples48 — samples per packet at the 48 kHz Ogg clock (960 for 20 ms)
//	preSkip        — encoder lookahead at 48 kHz, written to OpusHead only
//	finalGranule   — preSkip + real input duration at 48 kHz (trims the padding)
//
// Page granule positions are the cumulative count of decoded samples produced
// by the stream so far, counted from zero (the first preSkip of which the
// decoder discards). Only the EOS page is clamped to finalGranule.
func WriteOggOpusFile(packets [][]byte, channels uint8, frameSamples48, preSkip int, finalGranule int64, inputRate uint32) []byte {

	if channels == 0 {
		channels = 1
	}
	if frameSamples48 <= 0 {
		frameSamples48 = 960
	}
	if inputRate == 0 {
		inputRate = 48000
	}

	out := oggPage(0x02, 0, 0, [][]byte{opusHeadPreSkip(channels, preSkip, inputRate)})
	out = append(out, oggPage(0x00, 0, 1, [][]byte{opusTags()})...)

	seq := uint32(2)
	granule := int64(0)
	const perPage = 25
	for i := 0; i < len(packets); i += perPage {
		end := min(i+perPage, len(packets))
		chunk := packets[i:end]
		granule += int64(len(chunk) * frameSamples48)
		header := byte(0x00)
		pageGranule := granule
		if end == len(packets) {
			header = 0x04 // EOS
			if finalGranule > 0 && finalGranule < granule {
				pageGranule = finalGranule
			}
		}
		out = append(out, oggPage(header, pageGranule, seq, chunk)...)
		seq++
	}
	if len(packets) == 0 {
		out = append(out, oggPage(0x04, 0, seq, [][]byte{{}})...)
	}
	return out
}

// OggCRCForTest exposes the page CRC to other packages' tests so they can
// verify produced files without duplicating the polynomial.
func OggCRCForTest(page []byte) uint32 { return oggCRC(page) }
