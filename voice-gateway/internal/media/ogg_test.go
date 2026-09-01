package media

import "testing"

func TestOggRoundTripPreservesOpusPackets(t *testing.T) {
	in := make([][]byte, 60)
	for i := range in {
		in[i] = []byte{0x78, byte(i), byte(i + 1), 0x09}
	}
	raw := WriteOggOpus(in, 2, 960)
	if string(raw[0:4]) != "OggS" {
		t.Fatal("missing ogg capture pattern")
	}
	out, err := ReadOggOpus(raw)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(out) != len(in) {
		t.Fatalf("packet count %d != %d", len(out), len(in))
	}
	for i := range in {
		if string(out[i]) != string(in[i]) {
			t.Fatalf("packet %d corrupted", i)
		}
	}
}

func TestOggHeadersAreExcludedFromAudio(t *testing.T) {
	out, err := ReadOggOpus(WriteOggOpus([][]byte{{1, 2, 3}}, 2, 960))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(out) != 1 || string(out[0]) != string([]byte{1, 2, 3}) {
		t.Fatalf("unexpected audio packets: %v", out)
	}
}

func TestOggRejectsNonOggAndTruncated(t *testing.T) {
	if _, err := ReadOggOpus([]byte("not an ogg stream at all............")); err == nil {
		t.Fatal("expected rejection of non-ogg input")
	}
	raw := WriteOggOpus([][]byte{make([]byte, 400)}, 2, 960)
	if _, err := ReadOggOpus(raw[:len(raw)-10]); err == nil {
		t.Fatal("expected rejection of truncated stream")
	}
}

func TestOggHandlesLargePacketLacing(t *testing.T) {
	big := make([]byte, 700)
	for i := range big {
		big[i] = byte(i)
	}
	out, err := ReadOggOpus(WriteOggOpus([][]byte{big}, 2, 960))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(out) != 1 || len(out[0]) != 700 {
		t.Fatalf("lacing lost data: %v", len(out))
	}
}
