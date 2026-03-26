// tests/smoke/report.ts
// Generates a self-contained HTML report from smoke test results.
// No external CSS/JS/fonts — everything is inline.

import type { RunResult, HistoricalEntry, CaseResult, BehaviorRating } from './types.js';

/**
 * Escape HTML special characters to prevent XSS from user-generated content
 * (prompts, responses, justifications, etc.).
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Format a score (0-1) as a percentage string like "65%" */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Pick a color based on score thresholds: green >= 0.8, amber 0.4-0.79, red < 0.4 */
function scoreColor(score: number): string {
  if (score >= 0.8) return '#22c55e';
  if (score >= 0.4) return '#f59e0b';
  return '#ef4444';
}

/** Map rating to its badge background color */
function ratingColor(rating: BehaviorRating): string {
  switch (rating) {
    case 'PASS': return '#22c55e';
    case 'PARTIAL': return '#f59e0b';
    case 'MISS': return '#ef4444';
  }
}

/** Format an ISO timestamp into a human-friendly string like "March 25, 2026 at 10:00 PM" */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/** Format a short date for chart labels like "Mar 20" */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

/** Format duration in ms to a human-readable string like "45s" or "2m 15s" */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Count PASS / PARTIAL / MISS across all behavior scores in a run.
 */
function countRatings(run: RunResult): { pass: number; partial: number; miss: number; total: number } {
  let pass = 0;
  let partial = 0;
  let miss = 0;
  for (const c of run.cases) {
    for (const s of c.scores) {
      switch (s.rating) {
        case 'PASS': pass++; break;
        case 'PARTIAL': partial++; break;
        case 'MISS': miss++; break;
      }
    }
  }
  return { pass, partial, miss, total: pass + partial + miss };
}

/**
 * Build an inline SVG bar chart showing overall score over time.
 * Each bar is labeled with the date and percentage.
 */
function buildTrendChart(history: HistoricalEntry[]): string {
  if (history.length === 0) return '';

  const barWidth = 48;
  const barGap = 16;
  const chartHeight = 180;
  const labelHeight = 40; // space for date + pct labels below bars
  const topPadding = 24; // space for pct label above bars
  const maxBarHeight = chartHeight - labelHeight - topPadding;

  const totalWidth = history.length * (barWidth + barGap) - barGap + 40; // 40 for left padding
  const svgHeight = chartHeight + 8;
  const leftPad = 20;

  const bars = history.map((entry, i) => {
    const x = leftPad + i * (barWidth + barGap);
    const barH = Math.max(4, entry.overallScore * maxBarHeight); // minimum 4px so zero scores are visible
    const y = topPadding + (maxBarHeight - barH);
    const color = scoreColor(entry.overallScore);
    const label = formatShortDate(entry.timestamp);
    const scorePct = pct(entry.overallScore);

    return [
      // Percentage label above bar
      `<text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="#374151" font-weight="600">${scorePct}</text>`,
      // The bar itself
      `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="4" fill="${color}" opacity="0.85"/>`,
      // Date label below bar
      `<text x="${x + barWidth / 2}" y="${chartHeight - 8}" text-anchor="middle" font-size="10" fill="#6b7280">${escapeHtml(label)}</text>`,
    ].join('\n      ');
  });

  return `
    <div class="section">
      <h2>Score Trend</h2>
      <div style="overflow-x: auto;">
        <svg width="${totalWidth}" height="${svgHeight}" viewBox="0 0 ${totalWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
          <!-- Baseline -->
          <line x1="${leftPad}" y1="${topPadding + maxBarHeight}" x2="${totalWidth - 10}" y2="${topPadding + maxBarHeight}" stroke="#e5e7eb" stroke-width="1"/>
          ${bars.join('\n          ')}
        </svg>
      </div>
    </div>`;
}

/**
 * Render a single case result as a collapsible details card.
 */
function renderCaseCard(caseResult: CaseResult): string {
  const { testCase, responses, scores, weightedScore, error } = caseResult;
  const color = scoreColor(weightedScore);

  // Tags as pills
  const tagPills = testCase.tags
    .map(t => `<span class="tag">${escapeHtml(t)}</span>`)
    .join(' ');

  // Prompt section — show all user turns
  const promptBlocks = testCase.turns
    .map(t => `<pre class="prompt-block">${escapeHtml(t.content)}</pre>`)
    .join('\n');

  // Response section
  const responseBlocks = responses
    .map(r => `
      <div class="response-block">
        <div class="response-meta">Agent: ${escapeHtml(r.agentId)} &middot; ${formatDuration(r.durationMs)}</div>
        <div class="response-content">${escapeHtml(r.content)}</div>
      </div>`)
    .join('\n');

  // Behaviors table
  // Look up the behavior description from expectedBehaviors by matching behaviorId
  const behaviorMap = new Map(testCase.expectedBehaviors.map(b => [b.id, b]));
  const behaviorRows = scores
    .map(s => {
      const behavior = behaviorMap.get(s.behaviorId);
      const desc = behavior ? escapeHtml(behavior.description) : escapeHtml(s.behaviorId);
      const weight = behavior ? behavior.weight : 'unknown';
      return `
        <tr>
          <td>${desc}</td>
          <td><span class="weight-label">${escapeHtml(weight)}</span></td>
          <td><span class="badge" style="background:${ratingColor(s.rating)}">${s.rating}</span></td>
          <td>${escapeHtml(s.justification)}</td>
        </tr>`;
    })
    .join('\n');

  // Failure modes
  const failureModes = testCase.failureModes.length > 0
    ? `<div class="failure-modes">
        <h4>Known Failure Modes</h4>
        <ul>${testCase.failureModes.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
      </div>`
    : '';

  // Error banner (if execution errored)
  const errorBanner = error
    ? `<div class="error-banner">${escapeHtml(error)}</div>`
    : '';

  return `
    <details class="case-card">
      <summary class="case-header">
        <span class="case-name">${escapeHtml(testCase.name)}</span>
        ${tagPills}
        <span class="case-score" style="background:${color}">${pct(weightedScore)}</span>
      </summary>
      <div class="case-body">
        ${errorBanner}
        <h4>Prompt</h4>
        ${promptBlocks}

        <h4>Response</h4>
        ${responseBlocks}

        <h4>Behaviors</h4>
        <table class="behaviors-table">
          <thead>
            <tr>
              <th>Behavior</th>
              <th>Weight</th>
              <th>Rating</th>
              <th>Justification</th>
            </tr>
          </thead>
          <tbody>
            ${behaviorRows}
          </tbody>
        </table>

        ${failureModes}
      </div>
    </details>`;
}

/**
 * Generate a complete, self-contained HTML report from smoke test run results.
 * Optionally includes a historical trend chart if history is provided.
 */
export function generateReport(run: RunResult, history?: HistoricalEntry[]): string {
  const ratings = countRatings(run);
  const overallColor = scoreColor(run.overallScore);
  const formattedTime = formatTimestamp(run.timestamp);
  const duration = formatDuration(run.durationMs);

  const trendSection = history && history.length > 0
    ? buildTrendChart(history)
    : '';

  const caseCards = run.cases.map(c => renderCaseCard(c)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Curia Smoke Test Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f9fafb;
      color: #111827;
      line-height: 1.6;
      padding: 0;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    /* -- Header -- */
    .header {
      text-align: center;
      padding: 40px 24px;
      background: #ffffff;
      border-bottom: 1px solid #e5e7eb;
      margin-bottom: 24px;
      border-radius: 12px;
    }

    .header h1 {
      font-size: 24px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 8px;
    }

    .header .meta {
      font-size: 14px;
      color: #6b7280;
      margin-bottom: 20px;
    }

    .overall-score {
      font-size: 72px;
      font-weight: 800;
      line-height: 1;
      margin: 16px 0 8px;
    }

    .overall-label {
      font-size: 14px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }

    /* -- Summary stats bar -- */
    .stats-bar {
      display: flex;
      justify-content: center;
      gap: 12px;
      flex-wrap: wrap;
      padding: 16px 24px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      margin-bottom: 24px;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      color: #374151;
    }

    .stat-value {
      font-weight: 700;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
    }

    .pill-pass { background: #22c55e; }
    .pill-partial { background: #f59e0b; }
    .pill-miss { background: #ef4444; }
    .pill-neutral { background: #6b7280; }

    /* -- Sections -- */
    .section {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .section h2 {
      font-size: 18px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 16px;
    }

    /* -- Case cards -- */
    .case-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      margin-bottom: 12px;
      overflow: hidden;
    }

    .case-card[open] {
      border-color: #d1d5db;
    }

    .case-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 20px;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }

    /* Hide default marker */
    .case-header::-webkit-details-marker { display: none; }
    .case-header::marker { content: ''; }

    .case-header::before {
      content: '\\25B6';
      font-size: 10px;
      color: #9ca3af;
      transition: transform 0.15s ease;
    }

    .case-card[open] > .case-header::before {
      transform: rotate(90deg);
    }

    .case-name {
      font-weight: 600;
      font-size: 15px;
      color: #111827;
      flex: 1;
    }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      background: #e0e7ff;
      color: #3730a3;
      text-transform: lowercase;
    }

    .case-score {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 700;
      color: #ffffff;
      min-width: 48px;
      text-align: center;
    }

    .case-body {
      padding: 0 20px 20px;
      border-top: 1px solid #f3f4f6;
    }

    .case-body h4 {
      font-size: 13px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 20px 0 8px;
    }

    .prompt-block {
      background: #f3f4f6;
      border-radius: 6px;
      padding: 12px 16px;
      font-size: 13px;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      white-space: pre-wrap;
      word-break: break-word;
      color: #1f2937;
      margin-bottom: 8px;
    }

    .response-block {
      border-left: 3px solid #6366f1;
      padding: 12px 16px;
      margin-bottom: 8px;
      background: #fafbff;
      border-radius: 0 6px 6px 0;
    }

    .response-meta {
      font-size: 11px;
      color: #9ca3af;
      margin-bottom: 6px;
    }

    .response-content {
      font-size: 14px;
      color: #1f2937;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* -- Behaviors table -- */
    .behaviors-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin-top: 4px;
    }

    .behaviors-table th {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 2px solid #e5e7eb;
      color: #6b7280;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .behaviors-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #f3f4f6;
      vertical-align: top;
    }

    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: 0.02em;
    }

    .weight-label {
      font-size: 12px;
      color: #6b7280;
    }

    .failure-modes {
      margin-top: 16px;
    }

    .failure-modes h4 {
      margin-bottom: 6px;
    }

    .failure-modes ul {
      padding-left: 20px;
      font-size: 13px;
      color: #6b7280;
    }

    .failure-modes li {
      margin-bottom: 4px;
    }

    .error-banner {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      color: #991b1b;
      padding: 10px 14px;
      font-size: 13px;
      margin-top: 12px;
    }

    /* -- Footer -- */
    .footer {
      text-align: center;
      padding: 24px;
      font-size: 12px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Curia Smoke Test Report</h1>
      <div class="meta">${escapeHtml(formattedTime)} &middot; Duration: ${duration}</div>
      <div class="overall-label">Overall Score</div>
      <div class="overall-score" style="color:${overallColor}">${pct(run.overallScore)}</div>
    </div>

    <div class="stats-bar">
      <span class="stat"><span class="stat-value">${run.cases.length}</span> cases</span>
      <span class="stat"><span class="stat-value">${ratings.total}</span> behaviors</span>
      <span class="pill pill-pass">PASS ${ratings.pass}</span>
      <span class="pill pill-partial">PARTIAL ${ratings.partial}</span>
      <span class="pill pill-miss">MISS ${ratings.miss}</span>
    </div>

    ${trendSection}

    <div class="section">
      <h2>Test Cases</h2>
      ${caseCards}
    </div>

    <div class="footer">Generated by Curia Smoke Test Framework</div>
  </div>
</body>
</html>`;
}
