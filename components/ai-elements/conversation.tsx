"use client";

// Modified from AI Elements (Apache-2.0, Copyright 2023 Vercel, Inc.); see NOTICE.

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createContext, useContext } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/**
 * use-stick-to-bottom's auto-follow is unreliable on coarse-pointer (touch)
 * devices: the follow/escape state deadlocks and any swipe-up snaps back to the
 * bottom, even after a turn finishes. Rather than fight the library, on touch we
 * bypass it entirely — a plain scrollable container with NO follow logic, so the
 * user always has full manual control. Desktop keeps StickToBottom's smooth
 * auto-follow. Only a purely manual submit-scroll (AutoScrollToLatest) still
 * runs on touch.
 */
const useIsTouch = (): boolean => {
  const [touch, setTouch] = useState<boolean>(false);
  useEffect(() => {
    setTouch(window.matchMedia("(pointer: coarse)").matches);
  }, []);
  return touch;
};

/** Shared scroll element for the touch (no-StickToBottom) path. */
const TouchScrollContext = createContext<RefObject<HTMLDivElement | null> | null>(
  null,
);
export const useTouchScroll = () => useContext(TouchScrollContext);

export const Conversation = ({
  className,
  ...props
}: ConversationProps) => {
  const isTouch = useIsTouch();
  const elRef = useRef<HTMLDivElement | null>(null);

  // Desktop: StickToBottom with smooth follow.
  if (!isTouch) {
    return (
      <StickToBottom
        className={cn("relative flex-1 overflow-y-hidden", className)}
        initial="smooth"
        resize="smooth"
        role="log"
        {...props}
      />
    );
  }

  // Touch: plain scrollable container, no follow logic — full manual control.
  return (
    <TouchScrollContext.Provider value={elRef}>
      <div
        ref={elRef}
        role="log"
        className={cn(
          "relative flex-1 overflow-y-auto overscroll-contain",
          className,
        )}
        {...props}
      >
        {props.children as React.ReactNode}
      </div>
    </TouchScrollContext.Provider>
  );
};

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  children,
  ...props
}: ConversationContentProps) => {
  const touchScroll = useTouchScroll();
  // Touch path (no StickToBottom): render a plain inner div.
  if (touchScroll) {
    return (
      <div className={cn("flex flex-col gap-8 p-4", className)}>
        {children as React.ReactNode}
      </div>
    );
  }
  return (
    <StickToBottom.Content
      className={cn("flex flex-col gap-8 p-4", className)}
      {...props}
    >
      {children}
    </StickToBottom.Content>
  );
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const touchScroll = useTouchScroll();

  // Touch: plain container, no StickToBottom context — show the button when
  // the user has scrolled up (not at the bottom); click jumps to the bottom.
  if (touchScroll) {
    return <TouchScrollButton className={className} {...props} />;
  }
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

/** Scroll-to-bottom arrow for the touch (no-StickToBottom) path: tracks the
 *  plain container's scroll posture from the shared ref. */
function TouchScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps) {
  const touchScroll = useTouchScroll();
  const [show, setShow] = useState(false);
  const elRef = touchScroll;

  useEffect(() => {
    const el2 = elRef?.current;
    if (!el2) return;
    const onScroll = () => {
      const near = el2.scrollHeight - el2.scrollTop - el2.clientHeight < 64;
      setShow(!near);
    };
    onScroll();
    el2.addEventListener("scroll", onScroll, { passive: true });
    return () => el2.removeEventListener("scroll", onScroll);
  }, [elRef]);

  const jump = useCallback(() => {
    const el2 = elRef?.current;
    if (!el2) return;
    el2.scrollTo({ top: el2.scrollHeight, behavior: "smooth" });
    setShow(false);
  }, [elRef]);

  return (
    show && (
      <Button
        className={cn(
          "sticky bottom-4 left-[50%] z-10 translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        onClick={jump}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
}

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel =
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (
    message: UIMessage,
    index: number
  ) => string = defaultFormatMessage
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
