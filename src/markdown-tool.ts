/**
 * Markdown-to-Notion page creation tool.
 *
 * Accepts a parent page ID, title, and markdown body, converts the markdown
 * into Notion block objects, and creates the page via the Notion API.
 * This avoids requiring the LLM to produce deeply nested Notion block JSON.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type RichText = {
  type: 'text'
  text: { content: string; link?: { url: string } | null }
  annotations?: {
    bold?: boolean
    italic?: boolean
    code?: boolean
    strikethrough?: boolean
  }
}

type NotionBlock = Record<string, unknown>

// ── Rich text parser ─────────────────────────────────────────────────────────

function parseInline(text: string): RichText[] {
  const result: RichText[] = []
  const re = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[(.+?)\]\((.+?)\))/g
  let last = 0

  for (const m of text.matchAll(re)) {
    if (m.index! > last) {
      result.push({ type: 'text', text: { content: text.slice(last, m.index!) } })
    }

    if (m[2]) {
      result.push({ type: 'text', text: { content: m[2] }, annotations: { bold: true, italic: true } })
    } else if (m[3]) {
      result.push({ type: 'text', text: { content: m[3] }, annotations: { bold: true } })
    } else if (m[4]) {
      result.push({ type: 'text', text: { content: m[4] }, annotations: { italic: true } })
    } else if (m[5]) {
      result.push({ type: 'text', text: { content: m[5] }, annotations: { code: true } })
    } else if (m[6]) {
      result.push({ type: 'text', text: { content: m[6] }, annotations: { strikethrough: true } })
    } else if (m[7] && m[8]) {
      result.push({ type: 'text', text: { content: m[7], link: { url: m[8] } } })
    }

    last = m.index! + m[0].length
  }

  if (last < text.length) {
    result.push({ type: 'text', text: { content: text.slice(last) } })
  }

  return result.length ? result : [{ type: 'text', text: { content: text } }]
}

// ── Block builders ───────────────────────────────────────────────────────────

function heading(level: 1 | 2 | 3, text: string): NotionBlock {
  const key = `heading_${level}`
  return { object: 'block', type: key, [key]: { rich_text: parseInline(text) } }
}

function paragraph(text: string): NotionBlock {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: parseInline(text) } }
}

function bulletedListItem(text: string): NotionBlock {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInline(text) } }
}

function numberedListItem(text: string): NotionBlock {
  return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: parseInline(text) } }
}

function divider(): NotionBlock {
  return { object: 'block', type: 'divider', divider: {} }
}

function codeBlock(code: string, language: string): NotionBlock {
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: [{ type: 'text', text: { content: code } }],
      language: language || 'plain text',
    },
  }
}

function tableBlock(rows: string[][]): NotionBlock {
  if (rows.length === 0) return paragraph('')
  const width = rows[0].length
  const tableRows = rows.map(row => ({
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: row.map(cell => parseInline(cell.trim())),
    },
  }))
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      has_column_header: true,
      children: tableRows,
    },
  }
}

// ── Markdown → blocks ────────────────────────────────────────────────────────

export function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.split('\n')
  const blocks: NotionBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push(codeBlock(codeLines.join('\n'), lang))
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3
      blocks.push(heading(level, headingMatch[2]))
      i++
      continue
    }

    // Divider
    if (/^---+$/.test(line.trim())) {
      blocks.push(divider())
      i++
      continue
    }

    // Table (pipe-delimited)
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        const raw = lines[i].trim()
        const cells = raw.split('|').slice(1, -1).map(c => c.trim())
        // Skip separator rows (|---|---|)
        if (!cells.every(c => /^[-:\s]+$/.test(c))) {
          tableRows.push(cells)
        }
        i++
      }
      if (tableRows.length > 0) {
        blocks.push(tableBlock(tableRows))
      }
      continue
    }

    // Bulleted list
    if (/^\s*[-*]\s+/.test(line)) {
      blocks.push(bulletedListItem(line.replace(/^\s*[-*]\s+/, '')))
      i++
      continue
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      blocks.push(numberedListItem(line.replace(/^\s*\d+\.\s+/, '')))
      i++
      continue
    }

    // Default: paragraph
    blocks.push(paragraph(line))
    i++
  }

  return blocks
}

// ── Tool definition (for MCP tools/list) ─────────────────────────────────────

export const MARKDOWN_TOOL_DEF = {
  name: 'create-page-from-markdown',
  description:
    'Create a new Notion page from markdown content. ' +
    'Accepts a parent page ID, a title, and a markdown string. ' +
    'Supports headings, paragraphs, bold, italic, code, tables, lists, and dividers. ' +
    'Use this instead of API-post-page when you want to create a page with formatted content.',
  inputSchema: {
    type: 'object' as const,
    required: ['parent_id', 'title', 'markdown'],
    properties: {
      parent_id: {
        type: 'string',
        description: 'The UUID of the parent page (the new page will be created as a child of this page)',
      },
      title: {
        type: 'string',
        description: 'The title of the new page',
      },
      markdown: {
        type: 'string',
        description:
          'The page body as a markdown string. Supports: # headings, **bold**, *italic*, `code`, tables (| col |), bullet lists (- item), numbered lists (1. item), --- dividers, and ```code blocks```.',
      },
    },
  },
}

// ── Tool execution ───────────────────────────────────────────────────────────

export async function executeMarkdownTool(
  args: { parent_id: string; title: string; markdown: string },
  headers: Record<string, string>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const blocks = markdownToBlocks(args.markdown)

  const body = {
    parent: { page_id: args.parent_id },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: args.title } }],
      },
    },
    children: blocks,
  }

  const notionHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  }
  if (!notionHeaders['Notion-Version']) {
    notionHeaders['Notion-Version'] = '2025-09-03'
  }

  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify(body),
  })

  const data = await resp.json()

  if (!resp.ok) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            code: (data as any).code || resp.status,
            message: (data as any).message || resp.statusText,
          }),
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          page_id: (data as any).id,
          url: (data as any).url,
          title: args.title,
        }),
      },
    ],
  }
}
