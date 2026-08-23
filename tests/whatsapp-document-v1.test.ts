import { describe, expect, it } from "vitest";

import {
  SUPPORTED_DOCUMENT_MIME,
  classifyInboundMessage,
  persistedModality,
} from "../src/lib/whatsapp/message-classification.core";

const doc = (document: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "wamid.D1",
  from: "60123456789",
  type: "document",
  document,
  ...extra,
});

describe("DOCUMENT V1 — STEP 1 classification only", () => {
  it("classifies a valid PDF document", () => {
    const c = classifyInboundMessage(
      doc({
        id: "doc-1",
        filename: "pakej-umrah.pdf",
        mime_type: SUPPORTED_DOCUMENT_MIME,
        file_size: 240_000,
      }),
    );
    expect(c.modality).toBe("document");
    expect(c.mediaId).toBe("doc-1");
    expect(c.filename).toBe("pakej-umrah.pdf");
    expect(c.mimeType).toBe("application/pdf");
    expect(c.fileSize).toBe(240_000);
    expect(c.caption).toBeNull();
    expect(c.text).toBe("");
    expect(c.processable).toBe(true);
  });

  it("captures a PDF caption verbatim and tolerates MIME parameters", () => {
    const c = classifyInboundMessage(
      doc({
        id: "doc-2",
        filename: "quotation.pdf",
        mime_type: "application/pdf; charset=binary",
        caption: "Ini sebut harga saya",
      }),
    );
    expect(c.modality).toBe("document");
    expect(c.caption).toBe("Ini sebut harga saya");
    expect(c.mimeType).toBe("application/pdf");
    expect(c.fileSize).toBeNull();
  });

  it("marks a PDF with no media id as not processable", () => {
    const c = classifyInboundMessage(
      doc({ filename: "a.pdf", mime_type: SUPPORTED_DOCUMENT_MIME }),
    );
    expect(c.modality).toBe("document");
    expect(c.mediaId).toBeNull();
    expect(c.processable).toBe(false);
  });

  it("still classifies a PDF that has no filename", () => {
    const c = classifyInboundMessage(doc({ id: "doc-3", mime_type: SUPPORTED_DOCUMENT_MIME }));
    expect(c.modality).toBe("document");
    expect(c.filename).toBeNull();
    expect(c.processable).toBe(true);
  });

  it("treats a missing MIME type as unsupported", () => {
    const c = classifyInboundMessage(doc({ id: "doc-4", filename: "unknown.pdf" }));
    expect(c.modality).toBe("unsupported");
    expect(c.mimeType).toBeNull();
    expect(c.processable).toBe(false);
  });

  it("returns a controlled unsupported result for non-PDF documents", () => {
    const c = classifyInboundMessage(
      doc({
        id: "doc-5",
        filename: "itinerary.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        file_size: 90_000,
      }),
    );
    expect(c.modality).toBe("unsupported");
    expect(c.rawType).toBe("document");
    expect(c.filename).toBe("itinerary.docx");
    expect(c.processable).toBe(false);
    expect(c.text).toBe("");
  });

  it("handles a malformed document payload without throwing", () => {
    const c = classifyInboundMessage({ id: "wamid.D9", from: "60123456789", type: "document" });
    expect(c.modality).toBe("unsupported");
    expect(c.mediaId).toBeNull();
    expect(c.filename).toBeNull();
    expect(c.fileSize).toBeNull();
    expect(c.processable).toBe(false);
    expect(classifyInboundMessage(null).modality).toBe("unsupported");
  });

  it("resolves the LID wa_id fallback for documents", () => {
    const c = classifyInboundMessage(
      { id: "wamid.D8", type: "document", document: { id: "doc-8", mime_type: "application/pdf" } },
      { contactWaId: "60176927864" },
    );
    expect(c.senderSource).toBe("wa_id");
    expect(c.from).toBe("60176927864");
    expect(c.modality).toBe("document");
  });

  it("regression: text, audio and image classification is unchanged", () => {
    const text = classifyInboundMessage({
      id: "t",
      from: "60123456789",
      type: "text",
      text: { body: "Salam" },
    });
    expect(text.modality).toBe("text");
    expect(text.processable).toBe(true);
    expect(text.filename).toBeNull();

    const audio = classifyInboundMessage({
      id: "a",
      from: "60123456789",
      type: "audio",
      audio: { id: "media-1" },
    });
    expect(audio.modality).toBe("audio");
    expect(audio.mediaId).toBe("media-1");

    const image = classifyInboundMessage({
      id: "i",
      from: "60123456789",
      type: "image",
      image: { id: "img-1", caption: "resit" },
    });
    expect(image.modality).toBe("image");
    expect(image.caption).toBe("resit");

    expect(persistedModality("text")).toBe("text");
    expect(persistedModality("audio")).toBe("audio");
    expect(persistedModality("image")).toBe("image");
  });
});
