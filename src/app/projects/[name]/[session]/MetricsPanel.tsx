"use client";

import type { ConversationMetrics } from "@/types";

interface MetricsPanelProps {
  metrics: ConversationMetrics | null;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmtNum = new Intl.NumberFormat("en-US");

function formatTokens(n: number | null): string {
  return n != null ? fmtNum.format(n) : "—";
}

function formatCost(n: number | null): string {
  return n != null ? `$${n.toFixed(2)}` : "—";
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MetricsPanel({ metrics }: MetricsPanelProps) {
  if (!metrics) {
    return (
      <div className="metrics-panel">
        <div className="metrics-panel-empty">No metrics yet</div>
      </div>
    );
  }

  const modelEntries = metrics.modelUsage
    ? Object.entries(metrics.modelUsage)
    : [];

  return (
    <div className="metrics-panel">
      {/* Tokens section */}
      <div className="mp-section mp-tokens">
        <div className="mp-row">
          <span className="mp-label">Input</span>
          <span className="mp-value">{formatTokens(metrics.inputTokens)}</span>
        </div>
        <div className="mp-row">
          <span className="mp-label">Output</span>
          <span className="mp-value">{formatTokens(metrics.outputTokens)}</span>
        </div>
        <div className="mp-row">
          <span className="mp-label">Context</span>
          <span className="mp-value">
            {formatTokens(metrics.contextWindow)}
          </span>
        </div>
        {(metrics.cacheReadInputTokens != null ||
          metrics.cacheCreationInputTokens != null) && (
          <>
            <div className="mp-row">
              <span className="mp-label">Cache Read</span>
              <span className="mp-value">
                {formatTokens(metrics.cacheReadInputTokens)}
              </span>
            </div>
            <div className="mp-row">
              <span className="mp-label">Cache Write</span>
              <span className="mp-value">
                {formatTokens(metrics.cacheCreationInputTokens)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Cost section */}
      <div className="mp-section mp-cost">
        <div className="mp-row">
          <span className="mp-label">Cost</span>
          <span className="mp-value">{formatCost(metrics.totalCostUsd)}</span>
        </div>
        {modelEntries.length > 1 &&
          modelEntries.map(([model, usage]) => (
            <div className="mp-row mp-indent" key={model}>
              <span className="mp-label">{model}</span>
              <span className="mp-value">{formatCost(usage.costUSD)}</span>
            </div>
          ))}
      </div>

      {/* Timing section */}
      <div className="mp-section mp-timing">
        <div className="mp-row">
          <span className="mp-label">Duration</span>
          <span className="mp-value">{formatDuration(metrics.durationMs)}</span>
        </div>
        <div className="mp-row">
          <span className="mp-label">API Time</span>
          <span className="mp-value">
            {formatDuration(metrics.durationApiMs)}
          </span>
        </div>
        <div className="mp-row">
          <span className="mp-label">Turns</span>
          <span className="mp-value">
            {metrics.numTurns != null ? fmtNum.format(metrics.numTurns) : "—"}
          </span>
        </div>
      </div>

      {/* Session info section */}
      {(metrics.model || metrics.claudeCodeVersion || metrics.mcpServers) && (
        <div className="mp-section mp-session">
          {metrics.model && (
            <div className="mp-row">
              <span className="mp-label">Model</span>
              <span className="mp-value">{metrics.model}</span>
            </div>
          )}
          {metrics.claudeCodeVersion && (
            <div className="mp-row">
              <span className="mp-label">Version</span>
              <span className="mp-value">{metrics.claudeCodeVersion}</span>
            </div>
          )}
          {metrics.mcpServers && metrics.mcpServers.length > 0 && (
            <div className="mp-row mp-wrap">
              <span className="mp-label">MCP</span>
              <span className="mp-value">
                {metrics.mcpServers.map((s) => (
                  <span
                    key={s.name}
                    className={`mp-badge ${s.status === "connected" ? "mp-badge-ok" : "mp-badge-warn"}`}
                  >
                    {s.name}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Compaction section */}
      {metrics.compactionCount > 0 && (
        <div className="mp-section mp-compaction">
          <div className="mp-row">
            <span className="mp-label">Compactions</span>
            <span className="mp-value">{metrics.compactionCount}</span>
          </div>
          {metrics.lastCompactionPreTokens != null && (
            <div className="mp-row">
              <span className="mp-label">Pre-compact Tokens</span>
              <span className="mp-value">
                {formatTokens(metrics.lastCompactionPreTokens)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Stop / error section */}
      {(metrics.stopReason ||
        metrics.errorSubtype ||
        (metrics.permissionDenials &&
          metrics.permissionDenials.length > 0)) && (
        <div className="mp-section mp-stop">
          {metrics.stopReason && (
            <div className="mp-row">
              <span className="mp-label">Stop</span>
              <span className="mp-value">{metrics.stopReason}</span>
            </div>
          )}
          {metrics.errorSubtype && (
            <div className="mp-row">
              <span className="mp-label">Error</span>
              <span className="mp-value mp-error-badge">
                {metrics.errorSubtype}
              </span>
            </div>
          )}
          {metrics.permissionDenials &&
            metrics.permissionDenials.length > 0 && (
              <div className="mp-row mp-wrap">
                <span className="mp-label">Denied</span>
                <span className="mp-value">
                  {metrics.permissionDenials.map((tool) => (
                    <span key={tool} className="mp-badge mp-badge-warn">
                      {tool}
                    </span>
                  ))}
                </span>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
