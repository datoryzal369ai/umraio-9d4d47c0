//go:build cgo

package tts

// TAIL AND DURATION REGRESSIONS for the voice-note encoder + file muxer.
//
// The risk this guards is real audio loss: a wrong granule clock, a missing
// drain frame or an off-by-one page boundary silently truncates or lengthens
// the note. Every case below checks the container clock AND an actual ffmpeg
// decode of the produced file.

import (
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	umedia "github.com/umraio/voice-gateway/internal/media"
)

func toneSamples(n int) []byte {
	out := make([]byte, n*2)
	for i := 0; i < n; i++ {
		v := int16(11000 * math.Sin(2*math.Pi*220*float64(i)/float64(SampleRateHz)))
		binary.LittleEndian.PutUint16(out[i*2:], uint16(v))
	}
	return out
}

type oggPageInfo struct {
	typ     byte
	granule int64
	seq     uint32
	serial  uint32
	version byte
}

func scanPages(t *testing.T, data []byte) []oggPageInfo {
	t.Helper()
	var pages []oggPageInfo
	off := 0
	for off < len(data) {
		if off+27 > len(data) || string(data[off:off+4]) != "OggS" {
			t.Fatalf("bad page at %d", off)
		}
		nsegs := int(data[off+26])
		body := 0
		for _, s := range data[off+27 : off+27+nsegs] {
			body += int(s)
		}
		end := off + 27 + nsegs + body
		raw := append([]byte(nil), data[off:end]...)
		stored := binary.LittleEndian.Uint32(raw[22:26])
		binary.LittleEndian.PutUint32(raw[22:26], 0)
		if umedia.OggCRCForTest(raw) != stored {
			t.Fatalf("crc mismatch at %d", off)
		}
		pages = append(pages, oggPageInfo{
			typ:     data[off+5],
			granule: int64(binary.LittleEndian.Uint64(data[off+6 : off+14])),
			seq:     binary.LittleEndian.Uint32(data[off+18 : off+22]),
			serial:  binary.LittleEndian.Uint32(data[off+14 : off+18]),
			version: data[off+4],
		})
		off = end
	}
	return pages
}

// decodedSamples48 returns the mono 48 kHz sample count ffmpeg produces.
func decodedSamples48(t *testing.T, ogg []byte) int {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	dir := t.TempDir()
	in := filepath.Join(dir, "a.ogg")
	out := filepath.Join(dir, "a.pcm")
	if err := os.WriteFile(in, ogg, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("ffmpeg", "-v", "error", "-i", in, "-f", "s16le", "-ar", "48000", "-ac", "1", "-y", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v %s", err, b)
	}
	st, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	return int(st.Size() / 2)
}

func TestVoiceNoteDurationAndTail(t *testing.T) {
	cases := map[string]int{
		"one_sample":     1,
		"sub_frame_10ms": SampleRateHz / 100,
		"exact_frame":    FileFrameSamples,
		"page_493ms":     SampleRateHz * 493 / 1000,
		"page_499ms":     SampleRateHz * 499 / 1000,
		"page_500ms":     SampleRateHz / 2,
		"page_501ms":     SampleRateHz * 501 / 1000,
		"one_second":     SampleRateHz,
	}
	for name, n := range cases {
		t.Run(name, func(t *testing.T) {
			file, err := EncodeOpusFile(toneSamples(n))
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			wantFinal := int64(file.PreSkip) + int64(n)*int64(GranuleRate/SampleRateHz)
			if file.FinalGranule != wantFinal {
				t.Fatalf("final granule %d, want %d", file.FinalGranule, wantFinal)
			}
			// Exactly one pass over input+lookahead: no gratuitous extra packet.
			wantPackets := (n + file.PreSkip/(GranuleRate/SampleRateHz) + FileFrameSamples - 1) / FileFrameSamples
			if len(file.Packets) != wantPackets {
				t.Fatalf("packets %d, want %d", len(file.Packets), wantPackets)
			}
			// The stream must always carry at least the pre-skip plus the input.
			if int64(len(file.Packets)*file.FrameSamples48) < wantFinal {
				t.Fatalf("encoded %d samples < required %d", len(file.Packets)*file.FrameSamples48, wantFinal)
			}

			ogg := umedia.WriteOggOpusFile(file.Packets, 1, file.FrameSamples48, file.PreSkip, file.FinalGranule, SampleRateHz)
			pages := scanPages(t, ogg)
			if len(pages) < 3 {
				t.Fatalf("only %d pages", len(pages))
			}
			serial := pages[0].serial
			var prev int64 = -1
			for i, p := range pages {
				if p.version != 0 {
					t.Fatalf("page %d version %d", i, p.version)
				}
				if p.serial != serial {
					t.Fatalf("page %d serial mismatch", i)
				}
				if int(p.seq) != i {
					t.Fatalf("page %d sequence %d", i, p.seq)
				}
				if (p.typ&0x02) != 0 && i != 0 {
					t.Fatalf("BOS on page %d", i)
				}
				if i == 0 && (p.typ&0x02) == 0 {
					t.Fatal("first page not BOS")
				}
				if (p.typ&0x04) != 0 && i != len(pages)-1 {
					t.Fatalf("EOS on page %d of %d", i, len(pages))
				}
				if p.granule < prev {
					t.Fatalf("granule regressed at page %d: %d < %d", i, p.granule, prev)
				}
				prev = p.granule
			}
			if pages[len(pages)-1].typ&0x04 == 0 {
				t.Fatal("last page not EOS")
			}
			if got := pages[len(pages)-1].granule; got != wantFinal {
				t.Fatalf("EOS granule %d, want %d", got, wantFinal)
			}

			// Real decode: the decoder must yield exactly the source duration
			// at 48 kHz (2x the 24 kHz input), pre-skip and padding removed.
			got := decodedSamples48(t, ogg)
			want := n * (GranuleRate / SampleRateHz)
			if got != want {
				t.Fatalf("decoded %d samples, want %d", got, want)
			}
		})
	}
}
