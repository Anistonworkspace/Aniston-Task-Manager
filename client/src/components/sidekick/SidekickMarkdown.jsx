import React from 'react';

/**
 * SidekickMarkdown — minimal markdown renderer for AI responses.
 *
 * Supports: paragraphs, **bold**, *italic*, `inline code`, ```code blocks```,
 * - / * bullets, numbered lists, ### headings, [links](url).
 *
 * Intentionally NOT a full markdown lib — keep the bundle small and the
 * output safe (no raw HTML). When the AI emits HTML inside a code block
 * it's rendered as text, which is what we want.
 *
 * The renderer is a recursive line-by-line parser. Each line yields its own
 * block element; code fences switch mode. This is enough fidelity for the
 * chat surface; the doc-editor uses Tiptap for the real WYSIWYG path.
 */
export default function SidekickMarkdown({ text }) {
  if (!text || typeof text !== 'string') return null;
  return <>{renderBlocks(text)}</>;
}

function renderBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (/^```/.test(line)) {
      const fenceLang = line.replace(/^```/, '').trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre
          key={key++}
          className="my-2 px-3 py-2 rounded-md text-[12px] font-mono overflow-x-auto"
          style={{ backgroundColor: 'rgba(15, 23, 42, 0.05)' }}
        >
          {fenceLang && <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">{fenceLang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading.
    const hMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length;
      const Tag = level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4';
      const sizeClass = level === 1 ? 'text-base' : level === 2 ? 'text-sm' : 'text-sm';
      blocks.push(
        <Tag key={key++} className={`${sizeClass} font-semibold mt-3 mb-1 text-text-primary`}>
          {renderInline(hMatch[2])}
        </Tag>
      );
      i++;
      continue;
    }

    // Bullet / numbered list (group consecutive list items into one <ul>/<ol>).
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        const cleaned = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        items.push(cleaned);
        i++;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag key={key++} className={`my-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} text-sm text-text-primary leading-relaxed`}>
          {items.map((it, idx) => (
            <li key={idx} className="my-0.5">{renderInline(it)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Blank line — paragraph break.
    if (!line.trim()) {
      i++;
      continue;
    }

    // Plain paragraph — accumulate consecutive non-blank, non-list, non-fence
    // lines into one <p>.
    const paragraphLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^```/.test(lines[i])
      && !/^\s*[-*]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !/^(#{1,3})\s+/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1.5 text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
        {renderInline(paragraphLines.join(' '))}
      </p>
    );
  }

  return blocks;
}

function renderInline(text) {
  if (!text) return null;
  // Inline code first to protect ** / * inside backticks.
  const codeParts = text.split(/(`[^`]+`)/g);
  const out = [];
  let k = 0;
  for (const part of codeParts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      out.push(
        <code key={k++} className="px-1 py-0.5 rounded text-[12px] font-mono" style={{ backgroundColor: 'rgba(15,23,42,0.06)' }}>
          {part.slice(1, -1)}
        </code>
      );
      continue;
    }
    // Bold + italic + links pass over the non-code segments.
    out.push(...renderEmphasis(part, k));
    k += 1000; // crude key bump; collisions are fine since React only cares uniqueness within parent
  }
  return out;
}

function renderEmphasis(segment, baseKey) {
  // **bold**, *italic*, [text](url). We do bold first because ** contains *.
  const out = [];
  let key = baseKey;

  // Tokenize: alternating bold / italic / link / plain.
  const tokens = tokenize(segment);
  for (const t of tokens) {
    if (t.type === 'bold') {
      out.push(<strong key={key++} className="font-semibold">{t.text}</strong>);
    } else if (t.type === 'italic') {
      out.push(<em key={key++}>{t.text}</em>);
    } else if (t.type === 'link') {
      out.push(
        <a
          key={key++}
          href={t.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:opacity-80"
        >
          {t.text}
        </a>
      );
    } else {
      out.push(<React.Fragment key={key++}>{t.text}</React.Fragment>);
    }
  }
  return out;
}

function tokenize(text) {
  const tokens = [];
  let rest = text;
  // Order matters: link, then bold, then italic. Whatever's left is plain.
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italicRe = /\*([^*]+)\*/;

  while (rest.length > 0) {
    const linkMatch = linkRe.exec(rest);
    const boldMatch = boldRe.exec(rest);
    const italicMatch = italicRe.exec(rest);

    const candidates = [
      linkMatch && { type: 'link', idx: linkMatch.index, match: linkMatch },
      boldMatch && { type: 'bold', idx: boldMatch.index, match: boldMatch },
      italicMatch && { type: 'italic', idx: italicMatch.index, match: italicMatch },
    ].filter(Boolean);

    if (candidates.length === 0) {
      tokens.push({ type: 'plain', text: rest });
      break;
    }

    candidates.sort((a, b) => a.idx - b.idx);
    const first = candidates[0];

    if (first.idx > 0) {
      tokens.push({ type: 'plain', text: rest.slice(0, first.idx) });
    }

    if (first.type === 'link') {
      tokens.push({ type: 'link', text: first.match[1], href: first.match[2] });
      rest = rest.slice(first.idx + first.match[0].length);
    } else if (first.type === 'bold') {
      tokens.push({ type: 'bold', text: first.match[1] });
      rest = rest.slice(first.idx + first.match[0].length);
    } else if (first.type === 'italic') {
      tokens.push({ type: 'italic', text: first.match[1] });
      rest = rest.slice(first.idx + first.match[0].length);
    }
  }

  return tokens;
}
