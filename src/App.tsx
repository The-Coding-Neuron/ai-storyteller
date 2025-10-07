import React, { useState, useCallback, ChangeEvent, useEffect, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';

// --- Configuration & Initialization ---
// IMPORTANT: Access the API Key using the Vite syntax
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

// Initialize the SDK instance outside the component
const ai = new GoogleGenAI({ apiKey: API_KEY });

// --- Helper Class: DataWriter (For WAV File Creation) ---
// Note: This class is kept for your advanced audio generation logic.
class DataWriter {
  private view: DataView;
  private offset: number = 0;

  constructor(view: DataView) {
    this.view = view;
  }

  writeString(str: string) {
    for (let i = 0; i < str.length; i++) {
      this.view.setUint8(this.offset + i, str.charCodeAt(i));
    }
    this.offset += str.length;
  }

  writeUint32(value: number) {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  writeUint16(value: number) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeUint8(value: number) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
}

// --- Constant Data ---
const loadingMessages = [
  "Our digital storyteller is crafting your tale...",
  "Brewing up a fantastic story...",
  "Consulting the muses for inspiration...",
  "Weaving words into magic...",
  "Turning imagination into narrative...",
];


// --- StoryCreator Component (The main logic block) ---
const StoryCreator = () => {
  const [image, setImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>('');
  const [story, setStory] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [currentLoadingMessage, setCurrentLoadingMessage] = useState(loadingMessages[0]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Effect for cycling through loading messages
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (loading) {
      interval = setInterval(() => {
        setCurrentLoadingMessage(prevMessage => {
          const currentIndex = loadingMessages.indexOf(prevMessage);
          const nextIndex = (currentIndex + 1) % loadingMessages.length;
          return loadingMessages[nextIndex];
        });
      }, 2500);
    }
    return () => clearInterval(interval);
  }, [loading]);

  // Image handlers
  const handleImageUpload = (file: File) => {
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const onImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      handleImageUpload(event.target.files[0]);
    }
  };

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.files && event.dataTransfer.files[0]) {
      handleImageUpload(event.dataTransfer.files[0]);
    }
  }, []);

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  
  const removeImage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setImage(null);
    setStory(null);
    setError(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
  };
  
  // The core function to call the Gemini API
  const handleGenerateStory = async () => {
    if (!image) {
      setError("Please upload an image first.");
      return;
    }
    
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setLoading(true);
    setStory(null);
    setError(null);

    let generatedStory = '';

    // --- 1. Story Generation (Multimodal) ---
    try {
      const mimeType = image.substring(image.indexOf(':') + 1, image.indexOf(';'));
      const base64Data = image.substring(image.indexOf(',') + 1);

      const imagePart = {
        inlineData: {
          data: base64Data,
          mimeType,
        },
      };

      const storyPrompt = prompt || 'Write a short, imaginative story based on this image.';
      const textPart = { text: storyPrompt };

      const textModelResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ parts: [imagePart, textPart] }],
      });

      generatedStory = textModelResponse.text;
      setStory(generatedStory);

    } catch (err) {
      console.error("Story generation failed:", err);
      setError("Sorry, we couldn't generate a story. Please try again.");
      setLoading(false);
      return;
    }
    
    // --- 2. Audio Generation (TTS) ---
    // NOTE: This part relies on the specific model 'gemini-2.5-flash-preview-tts' 
    // being available for the TTS modality, which may not be guaranteed 
    // via the public SDK. If this fails, consider the Google Cloud TTS API.
    try {
      const audioModelResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts', 
        contents: [{ parts: [{ text: generatedStory }] }],
        config: {
          responseModalities: ['AUDIO'],
        },
      });

      const audioData = audioModelResponse.candidates?.[0]?.content.parts[0]?.inlineData?.data;

      if (audioData) {
        // --- WAV Header Creation Logic ---
        const binaryString = window.atob(audioData);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const sampleRate = 24000;
        const numChannels = 1;
        const bitDepth = 16;
        const byteRate = sampleRate * numChannels * (bitDepth / 8);
        const blockAlign = numChannels * (bitDepth / 8);
        const dataSize = bytes.length;

        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const writer = new DataWriter(view);

        // Write WAV file header
        writer.writeString('RIFF'); 
        writer.writeUint32(36 + dataSize); 
        writer.writeString('WAVE'); 
        writer.writeString('fmt '); 
        writer.writeUint32(16); 
        writer.writeUint16(1); 
        writer.writeUint16(numChannels); 
        writer.writeUint32(sampleRate); 
        writer.writeUint32(byteRate); 
        writer.writeUint16(blockAlign); 
        writer.writeUint16(bitDepth); 
        writer.writeString('data'); 
        writer.writeUint32(dataSize); 

        // Write the actual audio data
        for (let i = 0; i < bytes.length; i++) {
          writer.writeUint8(bytes[i]);
        }

        const audioBlob = new Blob([buffer], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(audioBlob);

        if (audioRef.current) {
          audioRef.current.src = audioUrl;
        }
      } else {
        setError("Audio data not found in the response or invalid model specified.");
      }
    } catch (err) {
      console.error("Audio generation failed:", err);
      setError("An error occurred while generating the audio for the story.");
    } finally {
      setLoading(false);
    }
  };

  const isButtonDisabled = !image || loading;

  return (
    <div className="story-creator-container">
      <p className="tool-description">
        This tool uses Google's Gemini models to create a short, imaginative story based on an image you upload. You can also provide an optional text prompt to guide the narrative. Once the story is generated, it can be read aloud to you.
      </p>
      <div className="input-section">
        <div 
          className="image-uploader" 
          onClick={() => document.getElementById('file-input')?.click()}
          onDrop={onDrop}
          onDragOver={onDragOver}
          aria-label="Image upload area"
          role="button"
          tabIndex={0}
        >
          <input 
            type="file" 
            id="file-input" 
            accept="image/*" 
            onChange={onImageChange} 
            hidden 
          />
          {image ? (
            <>
              <img src={image} alt="Uploaded preview" className="image-preview" />
              <button onClick={removeImage} className="remove-image-btn" aria-label="Remove image">
                &times;
              </button>
            </>
          ) : (
            <div className="upload-prompt">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="upload-icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
              <span>Drag & drop or click to upload</span>
            </div>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Optional: Describe the characters, setting, or plot for your story..."
          className="prompt-textarea"
          aria-label="Story prompt"
        />
      </div>
      <button className="generate-button" disabled={isButtonDisabled} onClick={handleGenerateStory}>
        {loading ? 'Generating...' : 'Generate Story'}
      </button>

      <div className="story-output-container">
        {loading && (
          <div className="loader-container">
            <div className="loader"></div>
            <p className="loading-message">{currentLoadingMessage}</p>
          </div>
        )}
        {error && <div className="error-message">{error}</div>}
        {story && (
          <div className="story-content">
            <div className="story-header">
              <h2>Your Story</h2>
              <audio ref={audioRef} controls />
            </div>
            <p>{story}</p>
          </div>
        )}
      </div>
    </div>
  );
};


// --- Header Component ---
const Header = () => {
  return (
    <header>
      <h1>Digital Storyteller</h1>
    </header>
  );
};

// --- Main App Component ---
// This component ties the Header and StoryCreator together.
const App = () => {
  return (
    <>
      <Header />
      <main>
        <StoryCreator />
      </main>
    </>
  );
};

export default App;
