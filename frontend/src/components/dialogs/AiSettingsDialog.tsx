import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  Typography,
  MenuItem,
  InputAdornment,
} from '@mui/material';
import { useAiStore } from '../../stores/aiStore';

const MODEL_OPTIONS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'claude-3.5-sonnet',
  'claude-3-opus',
  'claude-3-haiku',
  'llama-3.1-405b',
  'llama-3.1-70b',
  'mistral-large',
  'custom',
];

const DEFAULT_API_URLS: Record<string, string> = {
  'gpt-4o': 'https://api.openai.com/v1/chat/completions',
  'gpt-4o-mini': 'https://api.openai.com/v1/chat/completions',
  'gpt-4-turbo': 'https://api.openai.com/v1/chat/completions',
  'gpt-3.5-turbo': 'https://api.openai.com/v1/chat/completions',
  'claude-3.5-sonnet': 'https://api.anthropic.com/v1/messages',
  'claude-3-opus': 'https://api.anthropic.com/v1/messages',
  'claude-3-haiku': 'https://api.anthropic.com/v1/messages',
  'llama-3.1-405b': 'https://api.together.xyz/v1/chat/completions',
  'llama-3.1-70b': 'https://api.together.xyz/v1/chat/completions',
  'mistral-large': 'https://api.mistral.ai/v1/chat/completions',
  'custom': 'https://api.openai.com/v1/chat/completions',
};

const AiSettingsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { settings, setSettings } = useAiStore();

  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URLS[settings.model] || settings.apiUrl || '');

  useEffect(() => {
    if (open) {
      setApiKey(settings.apiKey);
      setModel(settings.model);
      setApiUrl(DEFAULT_API_URLS[settings.model] || settings.apiUrl || '');
    }
  }, [open, settings]);

  const handleSave = () => {
    setSettings({ apiKey, model, apiUrl });
    onClose();
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setModel(val);
    if (DEFAULT_API_URLS[val]) {
      setApiUrl(DEFAULT_API_URLS[val]);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>AI Settings</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="API URL"
            fullWidth
            value={apiUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiUrl(e.target.value)}
            placeholder="https://api.openai.com/v1/chat/completions"
            helperText="OpenAI-compatible API endpoint"
          />
          <TextField
            label="API Key"
            fullWidth
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <Button
                    size="small"
                    onClick={() => {
                      const key = prompt('Enter your API key:');
                      if (key) setApiKey(key);
                    }}
                  >
                    Import
                  </Button>
                </InputAdornment>
              ),
            }}
            helperText="Your AI provider API key. Kept in your browser only."
          />
          <TextField
            select
            label="Model"
            fullWidth
            value={model}
            onChange={handleModelChange}
            helperText="Select your AI model. URL updates automatically for common providers."
          >
            {MODEL_OPTIONS.map((m) => (
              <MenuItem key={m} value={m}>
                {m}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default AiSettingsDialog;
