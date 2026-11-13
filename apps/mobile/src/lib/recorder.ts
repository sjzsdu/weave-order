import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { IS_H5, IS_WEAPP } from "./runtime";

/**
 * 语音批注：现场手上有布，长按说话。
 * - H5：MediaRecorder 录音 + Web Speech 实时转写（可用时）；
 * - 小程序：Taro RecorderManager 录音，转写由服务端 ASR 接入（当前保留录音）；
 * - App：原生录音模块未接入时退化为文字。
 */

interface SpeechResultAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechResultAlternative;
  length: number;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResult };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}
type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export interface VoiceNoteState {
  available: boolean;
  recording: boolean;
  seconds: number;
  audioPath: string | null;
  transcript: string;
  error: string | null;
  start(): Promise<void>;
  stop(): void;
  reset(): void;
}

export function useVoiceNote(): VoiceNoteState {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const manager = useRef<ReturnType<typeof Taro.getRecorderManager> | null>(null);

  useEffect(() => {
    if (!IS_WEAPP) return;
    const recorder = Taro.getRecorderManager();
    manager.current = recorder;
    recorder.onStop((result) => {
      setAudioPath(result.tempFilePath);
      setRecording(false);
    });
    recorder.onError(() => {
      setError("录音失败，可改用文字批注");
      setRecording(false);
    });
    return () => {
      recorder.stop();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
      mediaRecorder.current?.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      recognition.current?.abort();
    };
  }, []);

  const startTimer = () => {
    setSeconds(0);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setSeconds((value) => value + 1), 1000);
  };

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const available = IS_H5 || IS_WEAPP;

  const start = async (): Promise<void> => {
    setError(null);
    if (!available) {
      setError("当前端请用文字批注（App 录音模块待接入）");
      return;
    }
    try {
      if (IS_WEAPP) {
        manager.current?.start({ duration: 60_000, format: "mp3", sampleRate: 16_000 });
      } else {
        const speechWindow = window as SpeechWindow;
        const Ctor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
        if (Ctor) {
          const instance = new Ctor();
          instance.lang = "zh-CN";
          instance.continuous = true;
          instance.interimResults = true;
          instance.onresult = (event) => {
            let text = "";
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
              text += event.results[index]?.[0]?.transcript ?? "";
            }
            if (text) setTranscript(text);
          };
          instance.onerror = () => undefined;
          instance.start();
          recognition.current = instance;
        }
        const media = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.current = media;
        chunks.current = [];
        const recorder = new MediaRecorder(media);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.current.push(event.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunks.current, { type: "audio/webm" });
          setAudioPath(URL.createObjectURL(blob));
          media.getTracks().forEach((track) => track.stop());
        };
        recorder.start();
        mediaRecorder.current = recorder;
      }
      setRecording(true);
      startTimer();
    } catch {
      setError("没有麦克风权限，可改用文字批注");
      setRecording(false);
    }
  };

  const stop = (): void => {
    stopTimer();
    setRecording(false);
    if (IS_WEAPP) {
      manager.current?.stop();
      return;
    }
    mediaRecorder.current?.stop();
    mediaRecorder.current = null;
    recognition.current?.stop();
    recognition.current = null;
  };

  const reset = (): void => {
    stop();
    setSeconds(0);
    setAudioPath(null);
    setTranscript("");
    setError(null);
  };

  return { available, recording, seconds, audioPath, transcript, error, start, stop, reset };
}
