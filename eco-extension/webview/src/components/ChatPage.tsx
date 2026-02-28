import { useState, useEffect, useRef } from "react";
import { Markdown } from "./Markdown";
import { postMessage } from "../vscode";
import type { SuggestionContext, HostMessage } from "../types";

interface ChatPageProps {
  context: SuggestionContext | null;
}

interface Message {
  role: "ai" | "user";
  content: string;
}

export function ChatPage({ context }: ChatPageProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasAutoSent = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-send initial context message
  useEffect(() => {
    if (context && !hasAutoSent.current && messages.length === 0) {
      hasAutoSent.current = true;
      const autoMessage = `Analyze this ${context.type} issue and suggest a fix: ${context.description}`;
      setMessages([{ role: "user", content: autoMessage }]);
      setIsStreaming(true);
      setStreamingContent("");
      postMessage({ type: "chatMessage", text: autoMessage, context });
    }
  }, [context, messages.length]);

  // Listen for messages from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as HostMessage;
      switch (msg.type) {
        case "chatStreaming":
          setStreamingContent((prev) => prev + msg.chunk);
          break;
        case "chatDone":
          setIsStreaming(false);
          setMessages((prev) => [...prev, { role: "ai", content: msg.fullContent }]);
          setStreamingContent("");
          break;
        case "error":
          setIsStreaming(false);
          setStreamingContent("");
          setMessages((prev) => [
            ...prev,
            { role: "ai", content: `**Error:** ${msg.message}` },
          ]);
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    const text = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsStreaming(true);
    setStreamingContent("");
    postMessage({ type: "chatMessage", text, context });
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Context pill */}
      {context && (
        <div
          style={{
            padding: "5px 12px",
            borderBottom: "1px solid var(--vscode-panel-border)",
            flexShrink: 0,
            color: "var(--vscode-descriptionForeground)",
            fontSize: "11px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span className="codicon codicon-tag" style={{ fontSize: "11px", marginRight: "4px" }} />
          {context.type} · {context.files[0]}
        </div>
      )}

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <span
              style={{
                fontSize: "10px",
                color: "var(--vscode-descriptionForeground)",
                marginBottom: "4px",
              }}
            >
              {msg.role === "user" ? "you" : "eco"}
            </span>

            {msg.role === "user" ? (
              <div
                style={{
                  background: "var(--vscode-button-background)",
                  color: "var(--vscode-button-foreground)",
                  padding: "8px 12px",
                  borderRadius: "12px 12px 0 12px",
                  maxWidth: "85%",
                  fontSize: "var(--vscode-font-size)",
                  lineHeight: 1.5,
                  wordBreak: "break-word",
                }}
              >
                {msg.content}
              </div>
            ) : (
              <div style={{ maxWidth: "100%", width: "100%" }}>
                <Markdown content={msg.content} addCopyButtons />
              </div>
            )}
          </div>
        ))}

        {/* Streaming indicator */}
        {isStreaming && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            <span style={{ fontSize: "10px", color: "var(--vscode-descriptionForeground)", marginBottom: "4px" }}>
              eco
            </span>
            <div style={{ maxWidth: "100%", width: "100%" }}>
              {streamingContent ? (
                <Markdown content={streamingContent} />
              ) : (
                <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "var(--vscode-font-size)" }}>
                  …
                </span>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid var(--vscode-panel-border)",
          flexShrink: 0,
          display: "flex",
          alignItems: "flex-end",
          gap: "8px",
        }}
      >
        <textarea
          ref={textareaRef}
          className="eco-input"
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask a follow-up…"
          disabled={isStreaming}
          rows={1}
          style={{
            flex: 1,
            opacity: isStreaming ? 0.5 : 1,
            lineHeight: 1.5,
            minHeight: "32px",
          }}
        />
        <button
          className="eco-btn-icon"
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          title="Send"
          style={{
            color: input.trim() && !isStreaming
              ? "var(--vscode-button-background)"
              : "var(--vscode-descriptionForeground)",
            flexShrink: 0,
            marginBottom: "2px",
          }}
        >
          <span className="codicon codicon-send" style={{ fontSize: "14px" }} />
        </button>
      </div>
    </div>
  );
}
