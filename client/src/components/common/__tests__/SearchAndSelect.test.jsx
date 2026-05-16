import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import SearchAndSelect from '../SearchAndSelect';

const USERS = [
  { id: 'u1', name: 'Alice Anderson', email: 'alice@a.com', dept: 'Engineering' },
  { id: 'u2', name: 'Bob Brown', email: 'bob@b.com', dept: 'Engineering' },
  { id: 'u3', name: 'Carol Carter', email: 'carol@c.com', dept: 'Sales' },
];

describe('SearchAndSelect', () => {
  it('renders all items by default', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        getLabel={(u) => u.name}
      />
    );
    expect(screen.getByText('Alice Anderson')).toBeInTheDocument();
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('Carol Carter')).toBeInTheDocument();
  });

  it('filters items by search query', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        getLabel={(u) => u.name}
      />
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'carol' } });
    expect(screen.queryByText('Alice Anderson')).not.toBeInTheDocument();
    expect(screen.queryByText('Bob Brown')).not.toBeInTheDocument();
    expect(screen.getByText('Carol Carter')).toBeInTheDocument();
  });

  it('filters by secondary field too', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        getLabel={(u) => u.name}
        getSecondary={(u) => u.email}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob@' } });
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.queryByText('Alice Anderson')).not.toBeInTheDocument();
  });

  it('toggles selection in multi mode', () => {
    const onChange = vi.fn();
    render(
      <SearchAndSelect
        items={USERS}
        selected={[]}
        onChange={onChange}
        mode="multi"
        getLabel={(u) => u.name}
      />
    );
    fireEvent.click(screen.getByText('Alice Anderson'));
    expect(onChange).toHaveBeenCalledWith(['u1']);
  });

  it('returns id in single mode', () => {
    const onChange = vi.fn();
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={onChange}
        mode="single"
        getLabel={(u) => u.name}
      />
    );
    fireEvent.click(screen.getByText('Bob Brown'));
    expect(onChange).toHaveBeenCalledWith('u2');
  });

  it('groups items by groupBy function', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        getLabel={(u) => u.name}
        groupBy={(u) => u.dept}
      />
    );
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('shows inline create option when query has no exact match', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        allowCreate
        onCreate={() => {}}
        getLabel={(u) => u.name}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Person' } });
    expect(screen.getByText(/Create/)).toBeInTheDocument();
    expect(screen.getByText('New Person')).toBeInTheDocument();
  });

  it('hides inline create when exact match exists', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        allowCreate
        onCreate={() => {}}
        getLabel={(u) => u.name}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alice Anderson' } });
    expect(screen.queryByText(/Create.*Alice Anderson/)).not.toBeInTheDocument();
  });

  it('shows empty message when no items match', () => {
    render(
      <SearchAndSelect
        items={USERS}
        selected={null}
        onChange={() => {}}
        getLabel={(u) => u.name}
        emptyMessage="Nobody here"
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'xyz123' } });
    expect(screen.getByText('Nobody here')).toBeInTheDocument();
  });
});
