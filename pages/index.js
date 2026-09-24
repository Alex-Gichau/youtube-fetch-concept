import { useState } from 'react';

export default function Home() {
  const [url, setUrl] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFetch = async (e) => {
    e.preventDefault();
    if (!url.trim()) {
      setError('Please enter a URL');
      return;
    }

    setLoading(true);
    setError('');
    setResults([]);

    try {
      // Fetch without API key - using web scraping or alternative method
      const response = await fetch('/api/fetch-youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        throw new Error('Failed to fetch data');
      }

      const data = await response.json();
      setResults(data.items || []);
    } catch (err) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>YouTube URL/Playlist Fetcher</h1>
      
      <form onSubmit={handleFetch} style={{ marginBottom: '20px' }}>
        <input
          type="text"
          placeholder="Enter YouTube URL or Playlist URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '16px',
            borderRadius: '4px',
            border: '1px solid #ccc',
            marginBottom: '10px',
            boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: '#FF0000',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Fetching...' : 'Fetch'}
        </button>
      </form>

      {error && (
        <div style={{ color: 'red', marginBottom: '10px' }}>
          Error: {error}
        </div>
      )}

      {results.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#f0f0f0' }}>
              <th style={{ border: '1px solid #ddd', padding: '10px', textAlign: 'left' }}>Title</th>
              <th style={{ border: '1px solid #ddd', padding: '10px', textAlign: 'left' }}>Duration</th>
              <th style={{ border: '1px solid #ddd', padding: '10px', textAlign: 'left' }}>URL</th>
            </tr>
          </thead>
          <tbody>
            {results.map((item, index) => (
              <tr key={index}>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{item.title}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>{item.duration}</td>
                <td style={{ border: '1px solid #ddd', padding: '10px' }}>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
