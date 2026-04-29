import { useState } from 'react';

interface Props {
  onSearch: (query: string) => void;
  disabled: boolean;
}

export default function SearchBar({ onSearch, disabled }: Props) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <form onSubmit={handleSubmit} style={{
      padding: '0.75rem 1rem', background: '#161b22',
      borderBottom: '1px solid #21262d', display: 'flex', gap: '0.5rem'
    }}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={disabled ? 'Select a repo first' : 'Search symbols...'}
        disabled={disabled}
        style={{
          flex: 1, padding: '0.5rem 0.75rem', background: '#0d1117',
          border: '1px solid #30363d', borderRadius: '6px', color: '#c9d1d9',
          fontSize: '0.9rem', outline: 'none'
        }}
      />
      <button type="submit" disabled={disabled} style={{
        padding: '0.5rem 1rem', background: disabled ? '#21262d' : '#238636',
        border: 'none', borderRadius: '6px', color: '#fff', cursor: disabled ? 'default' : 'pointer',
        fontSize: '0.85rem', fontWeight: 600
      }}>
        Search
      </button>
    </form>
  );
}
