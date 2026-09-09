package media

// The voice-note writer must produce a spec-correct stream: BOS/EOS flags,
// contiguous sequence numbers, valid CRCs, the encoder pre-skip in OpusHead
// and a final granule clamped to the real duration. The call-path writer must
// be unaffected.

import (
	"encoding/binary"
	"testing"
)

type page struct {
	typ     byte
	granule int64
	seq     uint32
	payload []byte
}

func parsePages(t *testing.T, data []byte) []page {
	t.Helper()
	var pages []page
	off := 0
	for off < len(data) {
		if off+27 > len(data) || string(data[off:off+4]) != "OggS" {
			t.Fatalf("bad page at %d", off)
		}
		nsegs := int(data[off+26])
		segs := data[off+27 : off+27+nsegs]
		body := 0
		for _, s := range segs {
			body += int(s)
		}
		end := off + 27 + nsegs + body
		raw := append([]byte(nil), data[off:end]...)
		stored := binary.LittleEndian.Uint32(raw[22:26])
		binary.LittleEndian.PutUint32(raw[22:26], 0)
		if oggCRC(raw) != stored {
			t.Fatalf("crc mismatch at page offset %d", off)
		}
		pages = append(pages, page{
			typ:     data[off+5],
			granule: int64(binary.LittleEndian.Uint64(data[off+6 : off+14])),
			seq:     binary.LittleEndian.Uint32(data[off+18 : off+22]),
			payload: data[off+27+nsegs : end],
		})
		off = end
	}
	return pages
}

func TestWriteOggOpusFileStructure(t *testing.T) {
	// 32 packets = 30720 samples at 48 kHz, i.e. more than the real duration,
	// so the EOS page must be clamped down to finalGranule.
	packets := make([][]byte, 32)
	for i := range packets {
		packets[i] = []byte{0xfc, byte(i), 0x01}
	}
	preSkip := 624
	final := int64(preSkip) + 28800 // 0.6 s at 48 kHz
	out := WriteOggOpusFile(packets, 1, 960, preSkip, final, 24000)

	pages := parsePages(t, out)
	if len(pages) < 4 {
		t.Fatalf("expected header pages plus audio pages, got %d", len(pages))
	}
	for i, p := range pages {
		if int(p.seq) != i {
			t.Fatalf("page %d has sequence %d", i, p.seq)
		}
	}
	if pages[0].typ != 0x02 || string(pages[0].payload[:8]) != "OpusHead" {
		t.Fatal("first page must be a BOS OpusHead")
	}
	if pages[len(pages)-1].typ != 0x04 {
		t.Fatal("last page must be EOS")
	}
	if string(pages[1].payload[:8]) != "OpusTags" {
		t.Fatal("second page must be OpusTags")
	}
	if got := binary.LittleEndian.Uint16(pages[0].payload[10:12]); int(got) != preSkip {
		t.Fatalf("pre-skip %d, want %d", got, preSkip)
	}
	if got := binary.LittleEndian.Uint32(pages[0].payload[12:16]); got != 24000 {
		t.Fatalf("input rate %d", got)
	}
	if pages[0].payload[9] != 1 {
		t.Fatal("must be mono")
	}
	// Intermediate pages carry the cumulative decoded sample count from zero.
	if pages[2].granule != int64(25*960) {
		t.Fatalf("first audio page granule %d, want %d", pages[2].granule, 25*960)
	}
	if pages[len(pages)-1].granule != final {
		t.Fatalf("final granule %d, want %d", pages[len(pages)-1].granule, final)
	}
	if _, err := ReadOggOpus(out); err != nil {
		t.Fatalf("stream unreadable: %v", err)
	}
}

// Regression guard: the live-call writer keeps its own behaviour.
func TestWriteOggOpusCallPathUnchanged(t *testing.T) {
	out := WriteOggOpus([][]byte{{0xfc, 0x01}}, 2, 960)
	pages := parsePages(t, out)
	if binary.LittleEndian.Uint16(pages[0].payload[10:12]) != 312 {
		t.Fatal("call-path pre-skip changed")
	}
	if pages[0].payload[9] != 2 {
		t.Fatal("call-path channel default changed")
	}
}
