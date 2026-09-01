package media

// Minimal, dependency-free Ogg/Opus container support.
//
// The gateway carries raw Opus packets on RTP, but every ASR/TTS system in the
// UMRAIO control plane speaks in files. Packing outbound utterances into Ogg
// (and unpacking the TTS reply back into packets) is pure container work: the
// audio payload is never transcoded, inspected or logged here.

import (
	"encoding/binary"
	"errors"
)

const (
	oggCapture   = "OggS"
	opusPreSkip  = 312
	opusRate     = 48000
	oggSerialSee = 0x554d5241 // "UMRA"
)

var (
	ErrNotOgg      = errors.New("media: not an ogg stream")
	ErrOggTruncated = errors.New("media: truncated ogg page")
)

var oggCRCTable = func() [256]uint32 {
	var t [256]uint32
	for i := 0; i < 256; i++ {
		r := uint32(i) << 24
		for j := 0; j < 8; j++ {
			if r&0x80000000 != 0 {
				r = (r << 1) ^ 0x04c11db7
			} else {
				r <<= 1
			}
		}
		t[i] = r
	}
	return t
}()

func oggCRC(b []byte) uint32 {
	var crc uint32
	for _, c := range b {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^c]
	}
	return crc
}

func opusHead(channels uint8) []byte {
	h := make([]byte, 19)
	copy(h, "OpusHead")
	h[8] = 1
	h[9] = channels
	binary.LittleEndian.PutUint16(h[10:], opusPreSkip)
	binary.LittleEndian.PutUint32(h[12:], opusRate)
	// output gain (int16) and mapping family already zero.
	return h
}

func opusTags() []byte {
	vendor := []byte("umraio-voice-gateway")
	t := make([]byte, 0, 8+4+len(vendor)+4)
	t = append(t, []byte("OpusTags")...)
	t = binary.LittleEndian.AppendUint32(t, uint32(len(vendor)))
	t = append(t, vendor...)
	t = binary.LittleEndian.AppendUint32(t, 0)
	return t
}

func lacing(packet []byte) []byte {
	n := len(packet)/255 + 1
	seg := make([]byte, n)
	for i := 0; i < n-1; i++ {
		seg[i] = 255
	}
	seg[n-1] = byte(len(packet) % 255)
	return seg
}

func oggPage(headerType byte, granule int64, seq uint32, packets [][]byte) []byte {
	var segs []byte
	var body []byte
	for _, p := range packets {
		segs = append(segs, lacing(p)...)
		body = append(body, p...)
	}
	page := make([]byte, 0, 27+len(segs)+len(body))
	page = append(page, []byte(oggCapture)...)
	page = append(page, 0, headerType)
	page = binary.LittleEndian.AppendUint64(page, uint64(granule))
	page = binary.LittleEndian.AppendUint32(page, oggSerialSee)
	page = binary.LittleEndian.AppendUint32(page, seq)
	page = binary.LittleEndian.AppendUint32(page, 0) // CRC placeholder
	page = append(page, byte(len(segs)))
	page = append(page, segs...)
	page = append(page, body...)
	binary.LittleEndian.PutUint32(page[22:26], oggCRC(page))
	return page
}

// WriteOggOpus packs Opus packets into a single-stream Ogg file.
// frameSamples is samples per packet at 48 kHz (960 for 20 ms).
func WriteOggOpus(packets [][]byte, channels uint8, frameSamples int) []byte {
	if channels == 0 {
		channels = 2
	}
	if frameSamples <= 0 {
		frameSamples = 960
	}
	out := oggPage(0x02, 0, 0, [][]byte{opusHead(channels)})
	out = append(out, oggPage(0x00, 0, 1, [][]byte{opusTags()})...)

	seq := uint32(2)
	granule := int64(0)
	const perPage = 25 // <= 255 lacing values per page for 20 ms frames
	for i := 0; i < len(packets); i += perPage {
		end := i + perPage
		if end > len(packets) {
			end = len(packets)
		}
		chunk := packets[i:end]
		granule += int64(len(chunk) * frameSamples)
		header := byte(0x00)
		if end == len(packets) {
			header = 0x04 // EOS
		}
		out = append(out, oggPage(header, granule, seq, chunk)...)
		seq++
	}
	if len(packets) == 0 {
		out = append(out, oggPage(0x04, 0, seq, [][]byte{{}})...)
	}
	return out
}

// ReadOggOpus returns the Opus audio packets of an Ogg stream, excluding the
// OpusHead / OpusTags headers. Malformed input is an error, never silent audio.
func ReadOggOpus(data []byte) ([][]byte, error) {
	if len(data) < 27 || string(data[0:4]) != oggCapture {
		return nil, ErrNotOgg
	}
	var packets [][]byte
	var partial []byte
	off := 0
	for off < len(data) {
		if off+27 > len(data) || string(data[off:off+4]) != oggCapture {
			return nil, ErrNotOgg
		}
		nsegs := int(data[off+26])
		segStart := off + 27
		if segStart+nsegs > len(data) {
			return nil, ErrOggTruncated
		}
		segs := data[segStart : segStart+nsegs]
		bodyStart := segStart + nsegs
		bodyLen := 0
		for _, s := range segs {
			bodyLen += int(s)
		}
		if bodyStart+bodyLen > len(data) {
			return nil, ErrOggTruncated
		}
		body := data[bodyStart : bodyStart+bodyLen]

		cursor := 0
		for _, s := range segs {
			partial = append(partial, body[cursor:cursor+int(s)]...)
			cursor += int(s)
			if s < 255 {
				packet := partial
				partial = nil
				if len(packet) == 0 {
					continue
				}
				if len(packet) >= 8 {
					magic := string(packet[:8])
					if magic == "OpusHead" || magic == "OpusTags" {
						continue
					}
				}
				packets = append(packets, packet)
			}
		}
		off = bodyStart + bodyLen
	}
	return packets, nil
}
