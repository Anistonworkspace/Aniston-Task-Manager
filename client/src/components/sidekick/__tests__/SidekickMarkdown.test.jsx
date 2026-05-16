import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import SidekickMarkdown from '../SidekickMarkdown';

describe('SidekickMarkdown', () => {
  it('renders nothing for empty input', () => {
    const { container } = render(<SidekickMarkdown text="" />);
    expect(container.textContent).toBe('');
  });

  it('renders a plain paragraph', () => {
    render(<SidekickMarkdown text="Hello world" />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders **bold** as <strong>', () => {
    const { container } = render(<SidekickMarkdown text="this is **bold** text" />);
    const strong = container.querySelector('strong');
    expect(strong).toHaveTextContent('bold');
  });

  it('renders *italic* as <em>', () => {
    const { container } = render(<SidekickMarkdown text="this is *italic*" />);
    expect(container.querySelector('em')).toHaveTextContent('italic');
  });

  it('renders inline `code`', () => {
    const { container } = render(<SidekickMarkdown text="use `npm install` to install" />);
    expect(container.querySelector('code')).toHaveTextContent('npm install');
  });

  it('renders bullet lists', () => {
    const { container } = render(<SidekickMarkdown text={'- one\n- two\n- three'} />);
    const items = container.querySelectorAll('ul > li');
    expect(items.length).toBe(3);
  });

  it('renders ordered lists', () => {
    const { container } = render(<SidekickMarkdown text={'1. first\n2. second'} />);
    const items = container.querySelectorAll('ol > li');
    expect(items.length).toBe(2);
  });

  it('renders headings', () => {
    const { container } = render(<SidekickMarkdown text="### Heading 3" />);
    expect(container.querySelector('h4')).toHaveTextContent('Heading 3');
  });

  it('renders fenced code blocks with the language label', () => {
    const text = '```js\nconst x = 1;\n```';
    const { container } = render(<SidekickMarkdown text={text} />);
    expect(container.querySelector('pre code')).toHaveTextContent('const x = 1;');
  });

  it('renders [text](url) as a safe external link', () => {
    const { container } = render(<SidekickMarkdown text="see [docs](https://example.com)" />);
    const a = container.querySelector('a');
    expect(a).toHaveAttribute('href', 'https://example.com');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
