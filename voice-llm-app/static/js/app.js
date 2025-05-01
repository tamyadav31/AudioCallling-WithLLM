document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const startCallBtn = document.getElementById('startCall');
    const endCallBtn = document.getElementById('endCall');
    const statusElement = document.getElementById('status');
    const timerElement = document.getElementById('callTimer');
    const conversationHistoryElement = document.getElementById('conversationHistory');

    // Variables
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    let stream;
    let timerInterval;
    let callSeconds = 0;
    let isSpeaking = false;
    let silenceTimeout;
    let audioContext;
    let analyser;
    let source;
    let silenceDetector;
    let recordingStartTime;
    let isSilent = true;
    let silenceStart = 0;
    let speechStart = 0; // New variable to track speech onset
    let conversationHistory = []; // Store conversation history
    
    // Global state variables for turn management
    let isListening = false; // Explicitly track listening state
    let isProcessing = false; // Track if we're processing user input
    
    // Tuning parameters for voice detection
    const SILENCE_THRESHOLD = 0.02; // Increased threshold to reduce false positives
    const SILENCE_DURATION = 1200; // Longer silence duration before stopping
    const MIN_RECORDING_TIME = 500; // Minimum recording time
    const MAX_RECORDING_TIME = 8000; // Reduced maximum to avoid listening too long
    const MIN_SPEECH_THRESHOLD = 0.03; // Minimum threshold to consider actual speech
    const SPEECH_DURATION_THRESHOLD = 200; // How long sound needs to be above threshold to count as speech
    
    // Start call
    startCallBtn.addEventListener('click', async () => {
        try {
            // Clear conversation history when starting a new call
            conversationHistory = [];
            updateConversationHistoryUI();
            
            // Clear conversation history on the server
            try {
                await fetch('/clear_history', {
                    method: 'POST'
                });
            } catch (error) {
                console.error('Error clearing conversation history:', error);
            }
            
            // Request microphone permission with better audio settings
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 44100,
                    channelCount: 1
                }
            };
            
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Setup media recorder
            mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus',
                audioBitsPerSecond: 16000
            });
            
            // Setup audio context for voice activity detection
            setupVoiceActivityDetection(stream);
            
            mediaRecorder.ondataavailable = (event) => {
                audioChunks.push(event.data);
            };
            
            mediaRecorder.onstop = async () => {
                // Only process if we're still in recording mode and have audio data
                if (isRecording && audioChunks.length > 0) {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    audioChunks = [];
                    
                    updateStatus('Processing your speech...');
                    
                    try {
                        // Send audio to backend
                        const response = await processAudio(audioBlob);
                        
                        // If the call is still active
                        if (isRecording) {
                            // If we received conversation history from server
                            if (response && response.conversation_history) {
                                conversationHistory = response.conversation_history;
                                updateConversationHistoryUI();
                            }
                            
                            // Check if web search was used
                            const usedSearch = response.used_search || false;
                            
                            // Speak the LLM response
                            if (response && response.llm_response) {
                                // Set speaking flag to prevent any recording during speech
                                isSpeaking = true;
                                
                                // Update status with search indication if needed
                                if (usedSearch) {
                                    updateStatus('AI found information online and is speaking...');
                                } else {
                                    updateStatus('AI is speaking...');
                                }
                                
                                try {
                                    // Wait for speech to complete before starting the next recording
                                    await speakText(response.llm_response);
                                } catch (error) {
                                    console.error('Error during speech:', error);
                                } finally {
                                    // Ensure speaking flag is cleared even if there's an error
                                    isSpeaking = false;
                                }
                                
                                // Only restart recording after speech is complete and if still in call
                                if (isRecording) {
                                    updateStatus('Listening to your voice... (speak now)');
                                    
                                    // Double-check we're not speaking before starting to record
                                    // Use a longer delay to ensure clean transition
                                    console.log('Scheduling recording start after AI response...');
                                    setTimeout(() => {
                                        if (isRecording && !isSpeaking) {
                                            console.log('Starting recording after speech completion');
                                            startRecording();
                                        } else {
                                            console.log('Could not start recording: isRecording=', isRecording, 'isSpeaking=', isSpeaking);
                                        }
                                    }, 1000); // 1-second delay to ensure full separation between speech and recording
                                }
                            } else {
                                // If no response, just restart recording
                                if (isRecording) {
                                    updateStatus('Listening to your voice... (speak now)');
                                    startRecording();
                                }
                            }
                        }
                    } catch (error) {
                        console.error('Error in processing:', error);
                        if (isRecording && !isSpeaking) {
                            updateStatus('Error processing audio. Restarting listening...');
                            // Restart recording even if there was an error
                            startRecording();
                        }
                    }
                } else if (isRecording && !isSpeaking) {
                    // If no audio chunks were collected, just restart recording
                    startRecording();
                }
            };
            
            // Start initial recording
            isRecording = true;
            startRecording();
            updateStatus('Listening to your voice... (speak now)');
            
            // Start timer
            startTimer();
            
            // Update button states
            startCallBtn.disabled = true;
            endCallBtn.disabled = false;
            
        } catch (error) {
            console.error('Error accessing microphone:', error);
            updateStatus('Error accessing microphone. Please check permissions.', 'error');
        }
    });
    
    // Setup voice activity detection
    function setupVoiceActivityDetection(stream) {
        try {
            // Initialize audio context
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            source = audioContext.createMediaStreamSource(stream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.5;
            source.connect(analyser);
            
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            
            // This will be our continuous voice detection function
            silenceDetector = () => {
                if (!isRecording || !mediaRecorder) return;
                
                // Get audio data
                analyser.getByteFrequencyData(dataArray);
                
                // Calculate average volume level
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength / 255;
                
                // Current time for duration calculations
                const now = Date.now();
                const recordingDuration = now - recordingStartTime;
                
                // Detect if the user is speaking
                const currentlyActive = average > MIN_SPEECH_THRESHOLD;
                
                // Debug output (uncomment if needed for tuning)
                console.log('Audio level:', average.toFixed(4), currentlyActive ? 'SPEAKING' : 'SILENT', 'Duration:', recordingDuration);
                
                // Logic to track silence and actual speech
                if (currentlyActive) {
                    // User is speaking - reset silence timer
                    silenceStart = 0;
                    
                    // If we were previously silent, mark that we're now detecting speech
                    if (isSilent) {
                        // Only count as speech if it's loud enough and not just a brief noise
                        if (average > MIN_SPEECH_THRESHOLD) {
                            // Consider speech detected only when it lasts for a minimum duration
                            if (!speechStart) {
                                speechStart = now;
                            } else if (now - speechStart > SPEECH_DURATION_THRESHOLD) {
                                isSilent = false;
                                console.log('Speech detected at level:', average.toFixed(4));
                                updateStatus('Listening to your voice...');
                            }
                        }
                    }
                } else {
                    // Reset speech detection if the sound level drops
                    speechStart = 0;
                    
                    // User just became silent
                    if (!isSilent) {
                        if (silenceStart === 0) {
                            silenceStart = now;
                            console.log('Silence started at:', silenceStart);
                        }
                        
                        // Check if silence has persisted
                        const silenceDuration = now - silenceStart;
                        
                        // Stop recording after sufficient silence, but only if we've recorded for minimum time
                        // and we actually detected speech during this recording session
                        if (silenceDuration > SILENCE_DURATION && recordingDuration > MIN_RECORDING_TIME) {
                            // User has been silent for the threshold duration
                            isSilent = true;
                            console.log('Silence detected for', silenceDuration, 'ms, stopping recording after', recordingDuration, 'ms');
                            
                            // Stop recording due to silence (only if we're actually recording)
                            if (mediaRecorder && mediaRecorder.state === 'recording') {
                                updateStatus('Processing your speech...');
                                clearTimeout(silenceTimeout);
                                mediaRecorder.stop();
                                return; // End our silence detection loop
                            }
                        }
                    }
                }
                
                // Continue monitoring with higher frequency for more responsive detection
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    setTimeout(() => requestAnimationFrame(silenceDetector), 30); // Check at ~30ms intervals
                }
            };
            
        } catch (error) {
            console.error('Error setting up voice activity detection:', error);
        }
    }
    
    // Function to start recording with voice activity detection
    function startRecording() {
        // Double-check we're not speaking before starting to record
        if (isSpeaking) {
            console.log('Cannot start recording while speaking, will retry in 1 second');
            setTimeout(() => {
                if (isRecording && !isSpeaking) {
                    startRecording();
                }
            }, 1000);
            return;
        }
        
        if (!isRecording || !mediaRecorder) return;
        
        // Reset recording state
        audioChunks = [];
        recordingStartTime = Date.now();
        isSilent = true;  // Start assuming silence until we detect voice
        silenceStart = 0;
        speechStart = 0; // Reset speech detection
        
        // Start recording
        try {
            console.log('Starting recording...');
            mediaRecorder.start();
            
            // Start voice activity detection
            if (silenceDetector) {
                requestAnimationFrame(silenceDetector);
            }
            
            // Set a safety timeout as a fallback in case VAD fails
            clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
                if (mediaRecorder && mediaRecorder.state === 'recording' && !isSpeaking) {
                    console.log('Safety timeout reached, stopping recording');
                    mediaRecorder.stop();
                }
            }, MAX_RECORDING_TIME);
            
            // Set listening flag
            isListening = true;
            
        } catch (error) {
            console.error('Error starting recording:', error);
        }
    }
    
    // End call
    endCallBtn.addEventListener('click', () => {
        isRecording = false;
        
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
        
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        
        // Stop any ongoing speech
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        
        // Cleanup audio context
        if (audioContext) {
            try {
                if (source) source.disconnect();
                audioContext.close().catch(e => console.error('Error closing audio context:', e));
            } catch (e) {
                console.error('Error cleaning up audio resources:', e);
            }
        }
        
        // Stop timer
        stopTimer();
        
        updateStatus('Call ended');
        
        // Reset button states
        startCallBtn.disabled = false;
        endCallBtn.disabled = true;
        
        // Reset listening flag
        isListening = false;
    });
    
    // Process audio and get LLM response
    async function processAudio(audioBlob) {
        if (isProcessing) return; // Prevent multiple simultaneous processing
        
        try {
            isProcessing = true;
            isListening = false; // Stop listening while processing
            
            const formData = new FormData();
            formData.append('audio', audioBlob);
            
            updateStatus('Processing your speech...');
            const response = await fetch('/process_audio', {
                method: 'POST',
                body: formData
            });
            
            // Check if the response is ok
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            
            // Update conversation history
            if (result.transcript) {
                // Add user message to conversation history
                conversationHistory.push({
                    role: 'user',
                    content: result.transcript,
                    timestamp: new Date().toISOString()
                });
                
                // Update conversation history UI
                updateConversationHistoryUI();
                
                console.log('Transcript:', result.transcript);
                
                // Check if web search was used
                const usedSearch = result.used_search || false;
                
                // Add AI response to conversation history
                if (result.llm_response) {
                    conversationHistory.push({
                        role: 'assistant',
                        content: result.llm_response,
                        timestamp: new Date().toISOString(),
                        usedSearch: usedSearch
                    });
                    
                    // Update conversation history UI
                    updateConversationHistoryUI();
                }
                
                // Speak the LLM response
                if (result.llm_response) {
                    // Update status with search indication if needed
                    if (usedSearch) {
                        updateStatus('AI found information online and is speaking...');
                    } else {
                        updateStatus('AI is speaking...');
                    }
                    
                    try {
                        // Wait for speech to complete before starting the next recording
                        await speakText(result.llm_response);
                    } catch (error) {
                        console.error('Error during speech:', error);
                    } finally {
                        // Ensure speaking flag is cleared even if there's an error
                        isSpeaking = false;
                    }
                    
                    // Only restart recording after speech is complete and if still in call
                    if (isRecording) {
                        updateStatus('Listening to your voice... (speak now)');
                        
                        // Double-check we're not speaking before starting to record
                        // Use a longer delay to ensure clean transition
                        console.log('Scheduling recording start after AI response...');
                        setTimeout(() => {
                            if (isRecording && !isSpeaking && !isProcessing) {
                                console.log('Starting recording after speech completion');
                                isListening = true; // Explicitly start listening
                                startRecording();
                            } else {
                                console.log('Could not start recording: isRecording=', isRecording, 'isSpeaking=', isSpeaking, 'isProcessing=', isProcessing);
                            }
                        }, 1000); // 1-second delay to ensure full separation between speech and recording
                    }
                } else {
                    // If no response, just restart recording
                    if (isRecording) {
                        setTimeout(() => {
                            if (isRecording && !isSpeaking) {
                                isListening = true; // Explicitly start listening
                                startRecording();
                            }
                        }, 500);
                    }
                }
            }
        } catch (error) {
            console.error('Error processing audio:', error);
            updateStatus('Error processing your speech. Please try again.');
            
            // Restart recording after error
            if (isRecording) {
                setTimeout(() => {
                    if (isRecording && !isSpeaking) {
                        isListening = true; // Explicitly start listening
                        startRecording();
                    }
                }, 1000);
            }
        } finally {
            isProcessing = false; // Always reset processing flag
        }
    }
    
    // Text-to-speech using Web Speech API that returns a Promise
    function speakText(text) {
        return new Promise((resolve) => {
            if ('speechSynthesis' in window) {
                // Ensure no recording is happening during speech
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    mediaRecorder.stop();
                }
                
                // Set speaking flag to prevent any other actions during speech
                isSpeaking = true;
                isListening = false; // Explicitly stop listening while speaking
                
                // Cancel any pending silence timeouts
                clearTimeout(silenceTimeout);
                
                updateStatus('AI is speaking...');
                
                const utterance = new SpeechSynthesisUtterance(text);
                
                // Set properties for better speech quality
                utterance.rate = 1.0;  // Normal speaking rate
                utterance.pitch = 1.0; // Normal pitch
                utterance.volume = 1.0; // Full volume
                
                // Set up event listeners
                utterance.onend = () => {
                    console.log('Speech ended normally');
                    // Add a small delay after speech ends before clearing the flag
                    setTimeout(() => {
                        isSpeaking = false;
                        resolve();
                    }, 500); // 500ms delay to ensure complete separation
                };
                
                utterance.onerror = (event) => {
                    console.error('Speech synthesis error:', event);
                    // Add a small delay after speech error before clearing the flag
                    setTimeout(() => {
                        isSpeaking = false;
                        resolve();
                    }, 500);
                };
                
                // Cancel any ongoing speech before starting new speech
                window.speechSynthesis.cancel();
                
                // Start the speech
                console.log('Starting to speak:', text.substring(0, 30) + '...');
                window.speechSynthesis.speak(utterance);
                
                // Safety timeout in case onend doesn't fire
                // This is a known issue in some browsers
                const maxSpeechTime = Math.min(text.length * 80, 20000); // Cap at 20 seconds
                setTimeout(() => {
                    if (isSpeaking) {
                        console.log('Speech synthesis timeout reached');
                        // Add a small delay after speech timeout before clearing the flag
                        setTimeout(() => {
                            isSpeaking = false;
                            resolve();
                        }, 500);
                    }
                }, maxSpeechTime);
                
            } else {
                console.error('Text-to-speech not supported in this browser');
                isSpeaking = false;
                resolve(); // Resolve immediately if speech synthesis is not available
            }
        });
    }
    
    // Update status message
    function updateStatus(message, type = 'info') {
        statusElement.textContent = message;
        statusElement.className = 'status';
        statusElement.classList.add(`status-${type}`);
    }
    
    // Update conversation history UI
    function updateConversationHistoryUI() {
        if (!conversationHistory || conversationHistory.length === 0) {
            conversationHistoryElement.innerHTML = '<div class="empty-history">No conversation yet.</div>';
            return;
        }
        
        const conversationHistoryHTML = conversationHistory.map((entry, index) => {
            const isUser = entry.role === 'user';
            const isSearch = entry.content.includes('I found these results') || 
                            (index > 0 && !isUser && conversationHistory[index-1].role === 'user' && 
                             conversationHistory[index-1].content.match(/(current|latest|recent|today|news|weather|update)/i));
            
            const messageClass = isUser ? 'user-message' : 'assistant-message';
            const searchClass = (!isUser && isSearch) ? 'message-with-search' : '';
            
            return `
                <div class="message ${messageClass} ${searchClass}">
                    <div class="message-label">${isUser ? 'You' : 'AI'}</div>
                    <div class="message-content">${entry.content}</div>
                    ${entry.timestamp ? `<div class="message-timestamp">${entry.timestamp}</div>` : ''}
                </div>
            `;
        }).join('');
        
        conversationHistoryElement.innerHTML = conversationHistoryHTML;
        
        // Scroll to the bottom to show latest messages
        conversationHistoryElement.scrollTop = conversationHistoryElement.scrollHeight;
    }
    
    // Timer functions
    function startTimer() {
        callSeconds = 0;
        updateTimerDisplay();
        timerInterval = setInterval(() => {
            callSeconds++;
            updateTimerDisplay();
        }, 1000);
    }
    
    function stopTimer() {
        clearInterval(timerInterval);
    }
    
    function updateTimerDisplay() {
        const minutes = Math.floor(callSeconds / 60);
        const seconds = callSeconds % 60;
        timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
});