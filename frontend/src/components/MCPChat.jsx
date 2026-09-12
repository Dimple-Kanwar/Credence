import { useState } from "react";

export default function MCPChat({ messages, loading, onAsk }) {
  const [question, setQuestion] = useState("");

  function submit(event) {
    event.preventDefault();
    if (!question.trim() || loading) return;
    onAsk(question);
    setQuestion("");
  }

  return (
    <section className="chat-shell">
      <div className="chat-head">
        <div>
          <span className="panel-index">NATURAL LANGUAGE MCP</span>
          <h2>Ask the credit graph</h2>
          <p>Query the same MCP tools that power your agents, using plain language.</p>
        </div>
        <span className="chat-status"><i /> graph tools online</span>
      </div>
      <div className="chat-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={index} className={`chat-message ${message.role}`}>
            <span className="chat-role">{message.role === "user" ? "YOU" : "MCP"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {loading && <div className="chat-message assistant"><span className="chat-role">MCP</span><p className="chat-thinking">Querying indexed evidence...</p></div>}
      </div>
      <div className="chat-suggestions">
        <button type="button" onClick={() => setQuestion("Show the top agents by score")}>Top agents</button>
        <button type="button" onClick={() => setQuestion("Pull a report for 0x...")}>Credit report</button>
        <button type="button" onClick={() => setQuestion("What is the factoring rate?")}>Factoring rate</button>
      </div>
      <form className="chat-input-row" onSubmit={submit}>
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about an agent, score, or receivable..." aria-label="Ask the MCP credit assistant" />
        <button className="lookup-button" type="submit" disabled={loading || !question.trim()}>Send</button>
      </form>
    </section>
  );
}
