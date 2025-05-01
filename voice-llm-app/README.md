# Voice LLM Conversation App

A web application that enables voice conversations with OpenAI's language models. This app uses Whisper for speech-to-text, GPT for text generation, and the Web Speech API for text-to-speech.

## Features

- Voice input via microphone
- Real-time speech-to-text using OpenAI Whisper
- Text processing with OpenAI's GPT models
- Voice responses using the Web Speech API
- Conversation transcript display

## Prerequisites

- Python 3.7+ installed
- OpenAI API key
- Microphone access
- Modern web browser (Chrome recommended for best speech synthesis support)

## Installation

1. Clone or download this repository to your local machine
2. Install the required Python packages:

```
pip install -r requirements.txt
```

## Usage

1. Start the Flask server:

```
python app.py
```

2. Open your web browser and navigate to:

```
http://localhost:5000
```

3. Enter your OpenAI API key in the designated field
4. Click "Start Call" to begin a voice conversation
5. Speak into your microphone when prompted
6. The app will process your speech, send it to GPT, and speak the response
7. Continue the conversation as long as you want
8. Click "End Call" when you're finished

## Troubleshooting

- **Microphone not working**: Ensure your browser has permission to access your microphone
- **No audio output**: Check that your computer's audio output is working correctly
- **API errors**: Verify that your OpenAI API key is correct and has sufficient credits

## Technical Notes

- The application records audio in 5-second chunks for processing
- The Web Speech API is used for text-to-speech functionality
- OpenAI's Whisper API is used for speech-to-text
- GPT 3.5-Turbo is the default model, but you can modify the code to use GPT-4 if you have access

## Security

- Your OpenAI API key is stored locally in your browser's localStorage
- The key is only sent to your local Flask server, never to any third-party servers
- It's recommended to manage your API key usage and set appropriate limits in the OpenAI dashboard
