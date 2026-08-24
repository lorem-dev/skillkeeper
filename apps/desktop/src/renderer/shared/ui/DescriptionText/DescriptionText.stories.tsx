import type { Meta, StoryObj } from '@storybook/react';
import { DescriptionText } from './DescriptionText';

const meta = {
  title: 'shared/ui/DescriptionText',
  component: DescriptionText,
  args: { onOpenLink: () => {} },
} satisfies Meta<typeof DescriptionText>;

export default meta;

type Story = StoryObj<typeof meta>;

// A description with no markup at all -- a single text span, rendered as
// plain text with no link button.
export const PlainText: Story = {
  args: {
    spans: [{ kind: 'text', text: 'Reads and writes issues in your task tracker.' }],
  },
};

// A description containing one `[text](url)` link, surrounded by plain text
// on both sides.
export const WithLink: Story = {
  args: {
    spans: [
      { kind: 'text', text: 'See the ' },
      { kind: 'link', text: 'setup guide', url: 'https://mcp.example.com/mcp' },
      { kind: 'text', text: ' before installing.' },
    ],
  },
};

// The backend's `truncate_spans` cut this description mid-link: the link's
// own text was shortened and the ellipsis was appended INTO that same span
// (see `crates/skillkeeper-core/src/mcp/markup.rs`), never as a separate
// trailing text span. Both the shortened link text and the "..." must render
// together, inside the one clickable button.
export const TruncatedMidLink: Story = {
  args: {
    spans: [
      { kind: 'text', text: 'Full setup instructions: ' },
      { kind: 'link', text: 'Read the complete server configuration a...', url: 'https://mcp.example.com/mcp' },
    ],
  },
};

// Escaping here is structural (a React text child), not sanitizer-based --
// see this component's own doc comment. A description containing a literal
// `<script>` tag must render as those literal characters, never executed and
// never stripped.
export const ScriptTagLiteral: Story = {
  args: {
    spans: [{ kind: 'text', text: '<script>alert(1)</script>' }],
  },
};
