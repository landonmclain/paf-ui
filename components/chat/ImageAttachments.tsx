"use client";

// Image attachments for the composer. Each image uploads the moment it's
// attached (button, paste or drop), and the backend starts describing it with
// the agent's vision model right away — so the description is usually ready by
// the time the message is sent. The parent holds a PendingUploads ref: the
// attachment order plus one upload promise per attachment, which its submit
// handler awaits to get the upload ids to send.

import {
  AlertCircleIcon,
  CheckIcon,
  ImagePlusIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  PromptInputButton,
  PromptInputHeader,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { getUpload, uploadImage, type UploadInfo } from "@/lib/paf";

/** The composer's uploads: one per attachment, in attachment order. */
export class PendingUploads {
  private order: string[] = [];
  private uploads = new Map<string, Promise<UploadInfo>>();

  /** Match the current attachments: drop removed ones; returns the ids that
   *  still need an upload. */
  sync(attachmentIds: string[]): string[] {
    this.order = attachmentIds;
    for (const id of [...this.uploads.keys()]) {
      if (!attachmentIds.includes(id)) this.uploads.delete(id);
    }
    return attachmentIds.filter((id) => !this.uploads.has(id));
  }

  track(attachmentId: string, upload: Promise<UploadInfo>): void {
    this.uploads.set(attachmentId, upload);
  }

  get count(): number {
    return this.order.length;
  }

  /** The uploads for the current attachments, in order. Waits for any still
   *  in flight; rejects if one failed. */
  collect(): Promise<UploadInfo[]> {
    return Promise.all(
      this.order
        .map((id) => this.uploads.get(id))
        .filter((p): p is Promise<UploadInfo> => p !== undefined),
    );
  }
}

type Status =
  | { state: "failed"; error: string }
  | { state: UploadInfo["status"]; info: UploadInfo };

const POLL_MS = 2000;

/** Thumbnails + status for the composer's attached images (renders nothing
 *  when there are none). Must be inside <PromptInput>. */
export function ImageAttachments({
  agent,
  pending,
}: {
  agent: string;
  pending: PendingUploads;
}) {
  const { files, remove } = usePromptInputAttachments();
  // Keyed by attachment id; missing = still uploading.
  const [status, setStatus] = useState<Record<string, Status>>({});

  // Upload newly attached images; forget removed ones.
  useEffect(() => {
    const toUpload = pending.sync(files.map((f) => f.id));
    for (const f of files) {
      if (!toUpload.includes(f.id)) continue;
      const upload = (async () => {
        const blob = await (await fetch(f.url)).blob();
        return uploadImage(blob, f.filename || "image", agent);
      })();
      pending.track(f.id, upload);
      upload.then(
        (info) =>
          setStatus((s) => ({ ...s, [f.id]: { state: info.status, info } })),
        (err: Error) =>
          setStatus((s) => ({
            ...s,
            [f.id]: { state: "failed", error: err.message },
          })),
      );
    }
  }, [files, agent, pending]);

  // Follow descriptions still in progress.
  const describing = Object.entries(status).filter(
    ([, s]) => s.state === "describing",
  );
  const describingKey = describing.map(([id]) => id).join(",");
  useEffect(() => {
    if (!describingKey) return;
    const timer = setInterval(() => {
      for (const [attachmentId, s] of describing) {
        if (s.state !== "describing") continue;
        void getUpload(s.info.id, agent).then((info) => {
          if (info && info.status !== "describing") {
            setStatus((cur) => ({
              ...cur,
              [attachmentId]: { state: info.status, info },
            }));
          }
        });
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // `describing` is derived from `status`; describingKey captures its change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [describingKey, agent]);

  if (files.length === 0) return null;
  return (
    <PromptInputHeader className="gap-2 px-3 pt-3">
      {files.map((f) => {
        const s = status[f.id];
        return (
          <div
            key={f.id}
            className="relative size-16 overflow-hidden rounded-md border bg-muted"
            title={statusTitle(f.filename, s)}
          >
            {/* Blob URL preview; next/image adds nothing here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={f.url}
              alt={f.filename ?? "attached image"}
              className="size-full object-cover"
            />
            <StatusBadge status={s} />
            <button
              type="button"
              onClick={() => remove(f.id)}
              className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground hover:bg-background"
              aria-label={`Remove ${f.filename ?? "image"}`}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </PromptInputHeader>
  );
}

function StatusBadge({ status }: { status: Status | undefined }) {
  const base =
    "absolute bottom-0.5 left-0.5 flex items-center rounded-full bg-background/85 p-0.5";
  if (!status || status.state === "describing") {
    return (
      <span className={base}>
        <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
      </span>
    );
  }
  if (status.state === "ready") {
    return (
      <span className={base}>
        <CheckIcon className="size-3 text-emerald-500" />
      </span>
    );
  }
  if (status.state === "failed" || status.state === "error") {
    return (
      <span className={base}>
        <AlertCircleIcon className="size-3 text-destructive" />
      </span>
    );
  }
  return null; // "none": uploaded, no vision model to describe it
}

function statusTitle(name: string | undefined, s: Status | undefined): string {
  const label = name ?? "image";
  if (!s) return `${label}: uploading…`;
  switch (s.state) {
    case "describing":
      return `${label}: describing…`;
    case "ready":
      return `${label}: described`;
    case "error":
      return `${label}: couldn't be described (${s.info.error ?? "error"})`;
    case "failed":
      return `${label}: upload failed (${s.error})`;
    default:
      return `${label}: uploaded (no vision model)`;
  }
}

/** Opens the file picker for images. Must be inside <PromptInput>. */
export function AttachImageButton({
  className,
  disabled,
}: {
  className?: string;
  disabled?: boolean;
}) {
  const { openFileDialog } = usePromptInputAttachments();
  return (
    <PromptInputButton
      type="button"
      onClick={openFileDialog}
      disabled={disabled}
      className={className}
      aria-label="Attach images"
      title="Attach images"
    >
      <ImagePlusIcon className="size-4" />
    </PromptInputButton>
  );
}
