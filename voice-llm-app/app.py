from flask import Flask, request, jsonify, render_template, send_from_directory
import os
import tempfile
import openai
import requests
import json
import re
from bs4 import BeautifulSoup
from datetime import datetime
from dotenv import load_dotenv

# Load environment variables from .env file (if exists)
load_dotenv()

# Get API keys from environment variables
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GOOGLE_CSE_ID = os.getenv('GOOGLE_CSE_ID')

if not OPENAI_API_KEY:
    print("WARNING: OPENAI_API_KEY not found in environment variables. Please add it to your .env file.")
if not GOOGLE_API_KEY or not GOOGLE_CSE_ID:
    print("WARNING: Google search API credentials not found. Web search functionality will be disabled.")

app = Flask(__name__)

# Dictionary to store conversation history for each session
# We'll use a simple in-memory store for now
conversation_histories = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/process_audio', methods=['POST'])
def process_audio():
    try:
        # Check if API key is configured
        if not OPENAI_API_KEY:
            return jsonify({'error': 'OpenAI API key not configured on the server'}), 500
            
        # Check if the request contains an audio file
        if 'audio' not in request.files:
            return jsonify({'error': 'No audio file provided'}), 400
        
        # Set OpenAI API key
        openai.api_key = OPENAI_API_KEY
        
        # Get session ID (we'll use client IP for simplicity)
        session_id = request.remote_addr
        
        # Get audio file
        audio_file = request.files['audio']
        
        # Save audio to a temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as temp_audio:
            audio_path = temp_audio.name
            audio_file.save(audio_path)
        
        # Transcribe audio using OpenAI Whisper
        try:
            with open(audio_path, 'rb') as audio:
                transcript_response = openai.Audio.transcribe(
                    model="whisper-1",
                    file=audio
                )
            
            transcript = transcript_response.get('text', '')
            
            # Delete temporary file
            os.unlink(audio_path)
            
            # If no text was transcribed, return error
            if not transcript:
                return jsonify({
                    'transcript': 'No speech detected',
                    'llm_response': 'I couldn\'t hear what you said. Please try again.',
                    'conversation_history': get_conversation_history(session_id),
                    'used_search': False
                })
            
            # Store user message in conversation history
            add_message_to_history(session_id, 'user', transcript)
            
            # Check if the user is asking about current events or real-time information
            needs_search = should_perform_web_search(transcript)
            search_results = None
            
            # If we need to search and have API keys, perform the search
            if needs_search and GOOGLE_API_KEY and GOOGLE_CSE_ID:
                search_results = perform_web_search(transcript)
            
            # Process transcript with LLM
            llm_response = process_with_llm(session_id, transcript, search_results)
            
            # Store AI response in conversation history
            add_message_to_history(session_id, 'assistant', llm_response)
            
            return jsonify({
                'transcript': transcript,
                'llm_response': llm_response,
                'conversation_history': get_conversation_history(session_id),
                'used_search': search_results is not None
            })
            
        except Exception as e:
            # Ensure temp file is deleted even if there's an error
            if os.path.exists(audio_path):
                os.unlink(audio_path)
            raise e
        
    except Exception as e:
        print(f"Error processing audio: {str(e)}")
        return jsonify({'error': str(e)}), 500

def should_perform_web_search(text):
    """Determine if the query requires real-time information."""
    # List of keywords that indicate a need for current information
    current_event_keywords = [
        'current', 'latest', 'recent', 'today', 'yesterday', 'this week', 'this month',
        'this year', 'happening now', 'news', 'stock market', 'weather', 'forecast',
        'covid', 'pandemic', 'election', 'sports', 'score', 'winner', 'president',
        'prime minister', 'war', 'conflict', 'price of', 'update on', 'what is going on',
        'right now', 'breaking', 'last week', 'last month', 'jammu', 'kashmir',
        'incident', 'happened', 'event', 'attack', 'border', 'occurred', 'took place'
    ]
    
    # Check for questions about dates or times
    date_time_patterns = [
        r'what (day|date|time|month|year) is (it|today)',
        r'what is (today|tomorrow|yesterday)',
        r'what is the (date|time)',
        r'what is the current (time|year|month)',
        r'what is happening (today|now)',
        r'what happened (in|on|at|during) (last|this|the past|the previous|recent)',
        r'know what happened',
        r'tell me about (the|recent|latest)',
        r'news (about|on|in|regarding)'
    ]
    
    # Check if the text contains any current event keywords
    text_lower = text.lower()
    if any(keyword in text_lower for keyword in current_event_keywords):
        print(f"Web search triggered by keyword in: '{text}'")
        return True
    
    # Check for date/time patterns
    if any(re.search(pattern, text_lower) for pattern in date_time_patterns):
        print(f"Web search triggered by pattern match in: '{text}'")
        return True
    
    # Special case for location-based queries that might be about recent events
    locations = ['jammu', 'kashmir', 'delhi', 'mumbai', 'kolkata', 'chennai', 'bangalore']
    if any(location in text_lower for location in locations) and ('what' in text_lower or 'happened' in text_lower or 'news' in text_lower):
        print(f"Web search triggered by location query: '{text}'")
        return True
    
    print(f"No web search triggered for: '{text}'")
    return False

def perform_web_search(query):
    """Perform a web search for the given query."""
    try:
        # Add "latest" to the query to prioritize recent results
        search_query = f"{query} latest"
        
        # Call Google Custom Search API
        url = "https://www.googleapis.com/customsearch/v1"
        params = {
            'key': GOOGLE_API_KEY,
            'cx': GOOGLE_CSE_ID,
            'q': search_query,
            'num': 5  # Number of results to return
        }
        
        response = requests.get(url, params=params)
        search_data = response.json()
        
        if 'items' not in search_data:
            return None
        
        # Format the search results
        results = []
        for item in search_data['items']:
            result = {
                'title': item.get('title', ''),
                'link': item.get('link', ''),
                'snippet': item.get('snippet', ''),
                'source': item.get('displayLink', '')
            }
            results.append(result)
        
        # Create a formatted text summary for the LLM
        formatted_results = "Here are some recent search results that might help answer the query:\n\n"
        for i, result in enumerate(results, 1):
            formatted_results += f"{i}. {result['title']}\n"
            formatted_results += f"   Source: {result['source']}\n"
            formatted_results += f"   Summary: {result['snippet']}\n\n"
        
        return formatted_results
    
    except Exception as e:
        print(f"Error performing web search: {str(e)}")
        return None

def process_with_llm(session_id, text, search_results=None):
    """Process the transcribed text with OpenAI's GPT model, using conversation history and search results."""
    try:
        # Get conversation history for this session
        conversation = get_conversation_messages(session_id)
        
        # If we have search results, append them to the user's message
        if search_results:
            # Find the last user message
            for i in range(len(conversation) - 1, -1, -1):
                if conversation[i]["role"] == "user":
                    # Append search results as system message
                    conversation.insert(i + 1, {
                        "role": "system", 
                        "content": f"The user is asking about current events or real-time information. I've performed a web search and found these results that may help in formulating your response: {search_results}\n\nPlease use this information to provide an accurate and up-to-date answer. Cite sources when appropriate."
                    })
                    break
        
        # Add current date/time context
        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        time_context = {
            "role": "system",
            "content": f"Current date and time: {current_time}. You can use this information if the user asks about the current date, time, or day of the week."
        }
        conversation.insert(1, time_context)  # Insert after the initial system message
        
        # Make API request to OpenAI GPT
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",  # You can change to gpt-4 if available
            messages=conversation,
            max_tokens=150,  # Slightly increased for more detailed responses
            temperature=0.7
        )
        
        # Extract response text
        llm_response = response.choices[0].message.content.strip()
        return llm_response
        
    except Exception as e:
        print(f"Error calling OpenAI API: {str(e)}")
        return f"Sorry, I encountered an error: {str(e)}"

def get_conversation_messages(session_id):
    """Format conversation history into the format expected by OpenAI API."""
    # Initialize with system message if this is a new conversation
    if session_id not in conversation_histories or not conversation_histories[session_id]:
        return [{"role": "system", "content": "You are a helpful AI assistant engaged in a voice conversation. Keep your responses concise and natural for speech. You can reference our previous conversation. You can search the web for real-time information when necessary."}]
    
    # Convert our history format to OpenAI API format
    messages = [{"role": "system", "content": "You are a helpful AI assistant engaged in a voice conversation. Keep your responses concise and natural for speech. You can reference our previous conversation. You can search the web for real-time information when necessary."}]
    for msg in conversation_histories[session_id]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    
    return messages

def add_message_to_history(session_id, role, content):
    """Add a message to the conversation history."""
    if session_id not in conversation_histories:
        conversation_histories[session_id] = []
    
    current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conversation_histories[session_id].append({
        "role": role,
        "content": content,
        "timestamp": current_time
    })

def get_conversation_history(session_id):
    """Get the formatted conversation history for a session."""
    if session_id not in conversation_histories:
        return []
    
    return conversation_histories[session_id]

@app.route('/clear_history', methods=['POST'])
def clear_history():
    """Clear conversation history for a session."""
    session_id = request.remote_addr
    conversation_histories[session_id] = []
    return jsonify({"status": "success"})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
