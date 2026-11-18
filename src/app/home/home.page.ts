
import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  AfterViewChecked,
  ViewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import {
  IonContent,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonIcon,
  IonSpinner,
  IonToast
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
import {
  videocam,
  videocamOff,
  mic,
  micOff,
  call,
  copy,
  people,
  cameraReverse,
  alertCircle,
  refresh
} from 'ionicons/icons';

import {
  MeetService,
  PeerInfo
} from '../services/meet.service';

import { Socket } from 'socket.io-client';

interface BackgroundCallPlugin {
  startCall(options: { roomId: string }): Promise<void>;
  stopCall(): Promise<void>;
  requestNotificationPermission(): Promise<void>;
}

const BackgroundCall =
  registerPlugin<BackgroundCallPlugin>('BackgroundCall');

type ParticipantConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

interface PeerConnectionEntry {
  pc: RTCPeerConnection;
  name: string;
  stream: MediaStream;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setTimeout>;
  restartInProgress?: boolean;
  hasConnected?: boolean;
}

interface RemoteParticipant {
  id: string;
  name: string;
  stream: MediaStream;
  status: ParticipantConnectionStatus;
}

interface AudioMonitor {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButton,
    IonInput,
    IonItem,
    IonLabel,
    IonIcon,
    IonSpinner,
    IonToast
  ],
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss']
})
export class HomePage implements OnInit, OnDestroy, AfterViewChecked {

  @ViewChild('localVideo')
  localVideo?: ElementRef<HTMLVideoElement>;

  name = 'Guest';
  roomId = '';

  joined = false;
  connecting = false;
  muted = false;
  cameraOff = false;
  switchingCamera = false;

  toastMessage = '';

  participants: PeerInfo[] = [];
  remoteParticipants: RemoteParticipant[] = [];
  activeSpeaker?: RemoteParticipant;

  localStream?: MediaStream;

  isFrontCamera = true;

  // DRAGGABLE LOCAL VIDEO POSITION

  localPreviewX: number | null = null;
  localPreviewY: number | null = null;

  isDraggingLocalPreview = false;

  private dragPointerId: number | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  callDurationSeconds = 0;
  private callStartedAt = 0;
  private durationTimer?: ReturnType<typeof setInterval>;

  private socket?: Socket;
  private backButtonListener?: PluginListenerHandle;

  private peers = new Map<string, PeerConnectionEntry>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private audioMonitors = new Map<string, AudioMonitor>();

  private audioContext?: AudioContext;
  private speakerTimer?: ReturnType<typeof setInterval>;
  private lastSpeechTime = 0;
  private lastCameraDeviceId?: string;

  private lastSocketId?: string;
  private resumingConnection = false;

  private readonly rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' }
    ],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  constructor(private meet: MeetService) {
    addIcons({
      videocam,
      videocamOff,
      mic,
      micOff,
      call,
      copy,
      people,
      cameraReverse,
      alertCircle,
      refresh
    });
  }

  // DRAG LOCAL VIDEO

  startLocalVideoDrag(event: PointerEvent): void {
    const preview = event.currentTarget as HTMLElement | null;

    if (!preview || this.dragPointerId !== null) {
      return;
    }

    // Only allow the primary mouse button.
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const stage = preview.parentElement;

    if (!stage) return;

    event.preventDefault();

    const stageRect = stage.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();

    // Calculate the preview's position inside the video stage.
    const stageLeft = stageRect.left + stage.clientLeft;
    const stageTop = stageRect.top + stage.clientTop;

    const maxX = Math.max(
      0,
      stage.clientWidth - preview.offsetWidth
    );

    const maxY = Math.max(
      0,
      stage.clientHeight - preview.offsetHeight
    );

    this.localPreviewX = Math.max(
      0,
      Math.min(maxX, previewRect.left - stageLeft)
    );

    this.localPreviewY = Math.max(
      0,
      Math.min(maxY, previewRect.top - stageTop)
    );

    // Remember exactly where the user touched the preview.
    this.dragOffsetX = event.clientX - previewRect.left;
    this.dragOffsetY = event.clientY - previewRect.top;

    this.dragPointerId = event.pointerId;
    this.isDraggingLocalPreview = true;

    // Keep receiving pointer events even when the finger
    // or mouse moves outside the preview.
    try {
      preview.setPointerCapture(event.pointerId);
    } catch (error) {
      console.warn('Could not capture drag pointer:', error);
    }
  }

  // MOVE LOCAL VIDEO

  moveLocalVideo(event: PointerEvent): void {
    if (
      !this.isDraggingLocalPreview ||
      this.dragPointerId !== event.pointerId
    ) {
      return;
    }

    const preview = event.currentTarget as HTMLElement | null;
    const stage = preview?.parentElement;

    if (!preview || !stage) return;

    event.preventDefault();

    const stageRect = stage.getBoundingClientRect();

    const stageLeft = stageRect.left + stage.clientLeft;
    const stageTop = stageRect.top + stage.clientTop;

    const maxX = Math.max(
      0,
      stage.clientWidth - preview.offsetWidth
    );

    const maxY = Math.max(
      0,
      stage.clientHeight - preview.offsetHeight
    );

    const nextX =
      event.clientX - stageLeft - this.dragOffsetX;

    const nextY =
      event.clientY - stageTop - this.dragOffsetY;

    // Keep the local video completely inside the stage.
    this.localPreviewX = Math.max(
      0,
      Math.min(maxX, nextX)
    );

    this.localPreviewY = Math.max(
      0,
      Math.min(maxY, nextY)
    );
  }

  // FINISH DRAGGING

  endLocalVideoDrag(event: PointerEvent): void {
    if (
      this.dragPointerId === null ||
      event.pointerId !== this.dragPointerId
    ) {
      return;
    }

    const preview = event.currentTarget as HTMLElement | null;
    const pointerId = this.dragPointerId;

    this.dragPointerId = null;
    this.isDraggingLocalPreview = false;

    try {
      if (preview?.hasPointerCapture(pointerId)) {
        preview.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture may already have been released.
    }
  }

  // RESET LOCAL VIDEO POSITION

  private resetLocalVideoPosition(): void {
    this.localPreviewX = null;
    this.localPreviewY = null;

    this.dragPointerId = null;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;

    this.isDraggingLocalPreview = false;
  }

  // ANDROID BACK BUTTON

  ngOnInit(): void {
    if (Capacitor.getPlatform() !== 'android') return;

    void App.addListener('backButton', ({ canGoBack }) => {
      if (this.joined || this.connecting) {
        void App.minimizeApp().catch(error => {
          console.warn('Could not minimize Meet Lite:', error);
        });
        return;
      }

      if (canGoBack) {
        window.history.back();
      } else {
        void App.exitApp();
      }
    }).then(listener => {
      this.backButtonListener = listener;
    }).catch(error => {
      console.warn('Could not register Android Back handler:', error);
    });
  }

  // BACKGROUND CALL SERVICE

  private async startBackgroundCallService(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') return;

    try {
      await BackgroundCall.requestNotificationPermission();
    } catch (error) {
      console.warn('Notification permission was not granted:', error);
    }

    try {
      await BackgroundCall.startCall({ roomId: this.roomId });
    } catch (error) {
      console.warn('Could not start background call service:', error);
    }
  }

  private stopBackgroundCallService(): void {
    if (Capacitor.getPlatform() !== 'android') return;

    void BackgroundCall.stopCall().catch(error => {
      console.warn('Could not stop background call service:', error);
    });
  }

  get formattedCallDuration(): string {
    const hours = Math.floor(this.callDurationSeconds / 3600);
    const minutes = Math.floor((this.callDurationSeconds % 3600) / 60);
    const seconds = this.callDurationSeconds % 60;

    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
    }

    return `${mm}:${ss}`;
  }

  trackParticipant(
    _index: number,
    participant: RemoteParticipant
  ): string {
    return participant.id;
  }

  // CALL DURATION

  private updateCallDurationState(): void {
    const hasOtherParticipant = this.participants.some(
      participant => participant.id !== this.socket?.id
    );

    if (hasOtherParticipant) {
      if (!this.durationTimer) {
        this.startCallDuration();
      }
    } else {
      this.stopCallDuration();
    }
  }

  private startCallDuration(): void {
    if (this.durationTimer) return;

    this.callDurationSeconds = 0;
    this.callStartedAt = Date.now();

    this.durationTimer = setInterval(() => {
      this.callDurationSeconds = Math.floor(
        (Date.now() - this.callStartedAt) / 1000
      );
    }, 1000);
  }

  private stopCallDuration(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = undefined;
    }

    this.callStartedAt = 0;
    this.callDurationSeconds = 0;
  }

  // CREATE MEETING

  async createRoom(): Promise<void> {
    if (this.joined || this.connecting) return;
    await this.startMeeting('create-room');
  }

  // JOIN MEETING

  async joinRoom(): Promise<void> {
    if (this.joined || this.connecting) return;

    const code = this.roomId.trim().toUpperCase();

    if (!code) {
      this.toast('Enter a meeting code first.');
      return;
    }

    this.roomId = code;
    await this.startMeeting('join-room');
  }

  // START MEETING

  private async startMeeting(
    action: 'create-room' | 'join-room'
  ): Promise<void> {

    if (this.connecting || this.joined) return;

    this.connecting = true;

    // Start every new meeting with the preview in its default position.
    this.resetLocalVideoPosition();

    try {
      this.localStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: {
            facingMode: 'user',
            width: { ideal: 640, max: 640 },
            height: { ideal: 360, max: 360 },
            frameRate: { ideal: 20, max: 24 }
          }
        });

      const initialTrack =
        this.localStream.getVideoTracks()[0];

      this.lastCameraDeviceId =
        initialTrack?.getSettings().deviceId;

      this.updateCameraOrientation(initialTrack);
      this.attachLocalPreview();

      this.socket = this.meet.connect();
      this.bindSocketEvents();

      if (!this.socket.connected) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(
              new Error(
                'Cannot reach the meeting server. Check your connection.'
              )
            );
          }, 20000);

          this.socket!.once('connect', () => {
            clearTimeout(timeout);
            resolve();
          });

          this.socket!.once('connect_error', (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      }

      const payload = action === 'create-room'
        ? {
            name: this.name.trim() || 'Guest'
          }
        : {
            roomId: this.roomId.trim().toUpperCase(),
            name: this.name.trim() || 'Guest'
          };

      const result = await new Promise<{
        ok: boolean;
        roomId?: string;
        error?: string;
      }>((resolve, reject) => {

        const timeout = setTimeout(() => {
          reject(new Error('The server did not respond.'));
        }, 15000);

        this.socket!.emit(
          action,
          payload,
          (response: {
            ok: boolean;
            roomId?: string;
            error?: string;
          }) => {
            clearTimeout(timeout);
            resolve(response);
          }
        );
      });

      if (!result || !result.ok || !result.roomId) {
        throw new Error(
          result?.error || 'Could not enter the meeting.'
        );
      }

      this.roomId = result.roomId;
      this.joined = true;
      this.muted = false;
      this.cameraOff = false;

      await this.startBackgroundCallService();

      this.toast(
        action === 'create-room'
          ? 'Meeting created! Share your meeting code.'
          : 'Joined meeting successfully.'
      );

    } catch (error) {
      console.error('MEETING ERROR:', error);

      this.joined = false;
      this.stopCallDuration();

      for (const id of Array.from(this.peers.keys())) {
        this.closePeer(id);
      }

      this.participants = [];
      this.remoteParticipants = [];
      this.activeSpeaker = undefined;

      this.stopLocalMedia();
      this.stopSpeakerDetection();

      this.meet.disconnect();
      this.socket = undefined;

      this.resetLocalVideoPosition();

      this.toast(
        error instanceof Error
          ? error.message
          : 'Could not start the meeting.'
      );

    } finally {
      this.connecting = false;
    }
  }

  // CAMERA ORIENTATION

  private updateCameraOrientation(
    track?: MediaStreamTrack
  ): void {
    if (!track) return;

    const facing = track.getSettings().facingMode;

    if (facing === 'user') {
      this.isFrontCamera = true;
      return;
    }

    if (facing === 'environment') {
      this.isFrontCamera = false;
      return;
    }

    const label = track.label.toLowerCase();

    if (
      label.includes('front') ||
      label.includes('user') ||
      label.includes('facetime')
    ) {
      this.isFrontCamera = true;
    } else if (
      label.includes('back') ||
      label.includes('rear') ||
      label.includes('environment')
    ) {
      this.isFrontCamera = false;
    }
  }

  private attachLocalPreview(): void {
    if (!this.localStream || !this.localVideo) return;

    const video = this.localVideo.nativeElement;

    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    if (video.srcObject !== this.localStream) {
      video.srcObject = this.localStream;
    }

    if (!this.cameraOff && video.paused) {
      void video.play().catch(() => undefined);
    }
  }

  ngAfterViewChecked(): void {
    this.attachLocalPreview();
  }

  // SOCKET EVENTS

  private bindSocketEvents(): void {
    if (!this.socket) return;

    this.socket.off('room-users');
    this.socket.off('user-joined');
    this.socket.off('user-left');
    this.socket.off('user-reconnected');
    this.socket.off('offer');
    this.socket.off('answer');
    this.socket.off('ice-candidate');
    this.socket.off('room-error');
    this.socket.off('connect');
    this.socket.off('disconnect');

    this.socket.on('disconnect', reason => {
      console.warn('MEETING SOCKET DISCONNECTED:', reason);

      if (this.joined && this.socket?.id) {
        this.lastSocketId = this.socket.id;
      }

      this.remoteParticipants = this.remoteParticipants.map(peer => ({
        ...peer,
        status: 'reconnecting'
      }));
    });

    this.socket.on('connect', () => {
      console.log('MEETING SOCKET CONNECTED:', this.socket?.id);

      if (
        !this.joined ||
        !this.lastSocketId ||
        this.resumingConnection
      ) {
        return;
      }

      void this.resumeMeetingConnection();
    });

    this.socket.on(
      'room-users',
      async (users: PeerInfo[]) => {

        this.participants = [
          {
            id: this.socket!.id || 'self',
            name: this.name + ' (You)'
          },
          ...users
        ];

        this.updateCallDurationState();

        for (const user of users) {
          this.ensureRemoteTile(user.id, user.name);
          await this.createOffer(user.id, user.name);
        }
      }
    );

    this.socket.on(
      'user-joined',
      (user: PeerInfo) => {

        if (
          !this.participants.some(
            participant => participant.id === user.id
          )
        ) {
          this.participants = [
            ...this.participants,
            user
          ];
        }

        this.ensureRemoteTile(user.id, user.name);
        this.updateCallDurationState();
      }
    );

    this.socket.on(
      'user-left',
      ({ id }: { id: string }) => {

        this.closePeer(id);

        this.participants =
          this.participants.filter(
            participant => participant.id !== id
          );

        this.updateCallDurationState();
      }
    );

    this.socket.on(
      'user-reconnected',
      (data: {
        oldId: string;
        id: string;
        name: string;
      }) => {

        this.closePeer(data.oldId);

        this.participants =
          this.participants.filter(
            participant => participant.id !== data.oldId
          );

        if (
          !this.participants.some(
            participant => participant.id === data.id
          )
        ) {
          this.participants = [
            ...this.participants,
            {
              id: data.id,
              name: data.name
            }
          ];
        }

        this.ensureRemoteTile(data.id, data.name);
        this.updateCallDurationState();
      }
    );

    this.socket.on(
      'offer',
      async (data: {
        from: string;
        name: string;
        description: RTCSessionDescriptionInit;
      }) => {

        try {
          const entry = this.getPeer(
            data.from,
            data.name
          );

          const pc = entry.pc;

          if (pc.signalingState !== 'stable') {
            const polite = String(this.socket?.id || '') >
              String(data.from);

            if (!polite) {
              console.warn('Ignoring colliding offer from:', data.from);
              return;
            }

            await pc.setLocalDescription({
              type: 'rollback'
            });
          }

          await pc.setRemoteDescription(
            new RTCSessionDescription(data.description)
          );

          await this.flushCandidates(data.from, pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          this.socket?.emit('answer', {
            to: data.from,
            description: pc.localDescription
          });

        } catch (error) {
          console.error('OFFER ERROR:', error);
        }
      }
    );

    this.socket.on(
      'answer',
      async (data: {
        from: string;
        description: RTCSessionDescriptionInit;
      }) => {

        try {
          const entry = this.peers.get(data.from);

          if (entry) {
            await entry.pc.setRemoteDescription(
              new RTCSessionDescription(data.description)
            );

            await this.flushCandidates(data.from, entry.pc);
          }

        } catch (error) {
          console.error('ANSWER ERROR:', error);
        }
      }
    );

    this.socket.on(
      'ice-candidate',
      async (data: {
        from: string;
        candidate: RTCIceCandidateInit;
      }) => {

        try {
          const entry = this.peers.get(data.from);

          if (entry?.pc.remoteDescription) {
            await entry.pc.addIceCandidate(
              new RTCIceCandidate(data.candidate)
            );
          } else {
            const list =
              this.pendingCandidates.get(data.from) || [];

            list.push(data.candidate);

            this.pendingCandidates.set(data.from, list);
          }

        } catch (error) {
          console.error('ICE ERROR:', error);
        }
      }
    );

    this.socket.on(
      'room-error',
      (message: string) => this.toast(message)
    );
  }

  // CREATE OR UPDATE A REMOTE VIDEO TILE

  private ensureRemoteTile(
    id: string,
    name: string
  ): void {
    const existing = this.remoteParticipants.find(
      participant => participant.id === id
    );

    if (existing) {
      existing.name = name;
      return;
    }

    const entry = this.peers.get(id);

    this.remoteParticipants = [
      ...this.remoteParticipants,
      {
        id,
        name,
        stream: entry?.stream || new MediaStream(),
        status: entry?.hasConnected ? 'connected' : 'connecting'
      }
    ];

    if (!this.activeSpeaker) {
      this.activeSpeaker = this.remoteParticipants[0];
    }
  }

  private setParticipantStatus(
    id: string,
    status: ParticipantConnectionStatus
  ): void {
    this.remoteParticipants = this.remoteParticipants.map(
      participant => participant.id === id
        ? { ...participant, status }
        : participant
    );
  }

  private clearPeerStatusTimer(
    entry: PeerConnectionEntry
  ): void {
    if (entry.statusTimer) {
      clearTimeout(entry.statusTimer);
      entry.statusTimer = undefined;
    }
  }

  private clearPeerDisconnectTimer(
    entry: PeerConnectionEntry
  ): void {
    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = undefined;
    }
  }

  // MARK A PEER AS CONNECTED

  private markPeerConnected(
    id: string,
    entry: PeerConnectionEntry
  ): void {
    if (this.peers.get(id) !== entry) return;

    entry.hasConnected = true;

    this.clearPeerDisconnectTimer(entry);
    this.clearPeerStatusTimer(entry);

    this.setParticipantStatus(id, 'connected');
  }

  // FAILED CONNECTION TIMER

  private scheduleFailedStatus(
    id: string,
    entry: PeerConnectionEntry,
    delay = 20000
  ): void {
    this.clearPeerStatusTimer(entry);

    entry.statusTimer = setTimeout(() => {
      entry.statusTimer = undefined;

      if (this.peers.get(id) !== entry) {
        return;
      }

      const connectionConnected =
        entry.pc.connectionState === 'connected';

      const iceConnected =
        entry.pc.iceConnectionState === 'connected' ||
        entry.pc.iceConnectionState === 'completed';

      if (connectionConnected || iceConnected) {
        this.markPeerConnected(id, entry);
        return;
      }

      this.setParticipantStatus(id, 'failed');
    }, delay);
  }

  // REJOIN PARTICIPANT

  async rejoinParticipant(id: string): Promise<void> {
    if (!this.joined || !this.socket?.connected) {
      this.toast(
        'Your meeting connection is offline. Please wait for it to reconnect.'
      );
      return;
    }

    const participant = this.remoteParticipants.find(
      peer => peer.id === id
    );

    if (!participant) return;

    this.setParticipantStatus(id, 'reconnecting');

    const entry = this.peers.get(id);

    if (entry) {
      this.clearPeerDisconnectTimer(entry);
      this.clearPeerStatusTimer(entry);

      const pcIsClosed =
        String(entry.pc.connectionState) === 'closed' ||
        String(entry.pc.signalingState) === 'closed';

      if (!pcIsClosed) {
        this.scheduleFailedStatus(id, entry, 20000);

        if (entry.pc.signalingState === 'stable') {
          await this.restartPeerConnection(id, entry);
        } else {
          this.toast(
            'Reconnecting. Please wait for the current connection attempt to finish.'
          );
        }

        return;
      }

      this.closePeer(id);
    }

    this.ensureRemoteTile(id, participant.name);

    const newEntry = this.getPeer(id, participant.name);

    this.scheduleFailedStatus(id, newEntry, 25000);

    await this.createOffer(id, participant.name);
  }

  // RESUME AFTER SOCKET RECONNECTION

  private async resumeMeetingConnection(): Promise<void> {
    if (
      !this.socket ||
      !this.lastSocketId ||
      this.resumingConnection
    ) {
      return;
    }

    this.resumingConnection = true;

    const previousId = this.lastSocketId;

    for (const id of Array.from(this.peers.keys())) {
      this.closePeer(id);
    }

    this.remoteParticipants = [];
    this.activeSpeaker = undefined;
    this.stopSpeakerDetection();

    try {
      const result = await new Promise<{
        ok: boolean;
        error?: string;
      }>((resolve, reject) => {

        const timeout = setTimeout(() => {
          reject(new Error('Meeting reconnection timed out.'));
        }, 15000);

        this.socket!.emit(
          'resume-room',
          {
            roomId: this.roomId,
            previousSocketId: previousId
          },
          (response: {
            ok: boolean;
            error?: string;
          }) => {
            clearTimeout(timeout);
            resolve(response);
          }
        );
      });

      if (!result.ok) {
        throw new Error(
          result.error || 'Could not resume the meeting.'
        );
      }

      this.lastSocketId = undefined;
      this.toast('Connection restored. Reconnecting participants...');

    } catch (error) {
      console.error('MEETING RESUME ERROR:', error);

      this.toast(
        error instanceof Error
          ? error.message
          : 'Could not restore the meeting. Please rejoin.'
      );

    } finally {
      this.resumingConnection = false;
    }
  }

  // GET OR CREATE PEER

  private getPeer(
    id: string,
    name: string
  ): PeerConnectionEntry {

    const existing = this.peers.get(id);

    if (
      existing &&
      existing.pc.signalingState !== 'closed'
    ) {
      existing.name = name;
      this.ensureRemoteTile(id, name);
      return existing;
    }

    if (existing) {
      this.closePeer(id);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);

    const entry: PeerConnectionEntry = {
      pc,
      name,
      stream: new MediaStream(),
      hasConnected: false
    };

    this.peers.set(id, entry);
    this.ensureRemoteTile(id, name);

    this.scheduleFailedStatus(id, entry, 25000);

    this.localStream?.getTracks().forEach(track => {
      const sender = pc.addTrack(
        track,
        this.localStream!
      );

      if (track.kind === 'video') {
        void this.limitVideoBitrate(sender);
      }
    });

    pc.onicecandidate = event => {
      if (event.candidate) {
        this.socket?.emit('ice-candidate', {
          to: id,
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.ontrack = event => {
      const stream = entry.stream;

      const alreadyAdded = stream
        .getTracks()
        .some(track => track.id === event.track.id);

      if (!alreadyAdded) {
        stream.addTrack(event.track);
      }

      this.addRemoteParticipant(
        id,
        entry.name,
        stream
      );

      event.track.onunmute = () => {
        this.addRemoteParticipant(
          id,
          entry.name,
          stream
        );

        if (
          pc.connectionState === 'connected' ||
          pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed'
        ) {
          this.markPeerConnected(id, entry);
        }
      };

      if (
        pc.connectionState === 'connected' ||
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed'
      ) {
        this.markPeerConnected(id, entry);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(
        'PEER CONNECTION STATE:',
        id,
        pc.connectionState
      );

      if (pc.connectionState === 'connected') {
        this.markPeerConnected(id, entry);
      }

      if (pc.connectionState === 'connecting') {
        this.setParticipantStatus(
          id,
          entry.hasConnected ? 'reconnecting' : 'connecting'
        );
      }

      if (pc.connectionState === 'disconnected') {
        this.setParticipantStatus(id, 'reconnecting');
        this.schedulePeerRecovery(id, entry);
        this.scheduleFailedStatus(id, entry, 20000);
      }

      if (pc.connectionState === 'failed') {
        this.setParticipantStatus(id, 'reconnecting');
        this.scheduleFailedStatus(id, entry, 15000);
        void this.restartPeerConnection(id, entry);
      }

      if (pc.connectionState === 'closed') {
        this.setParticipantStatus(id, 'failed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        'ICE CONNECTION STATE:',
        id,
        pc.iceConnectionState
      );

      if (
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed'
      ) {
        this.markPeerConnected(id, entry);
      }

      if (pc.iceConnectionState === 'disconnected') {
        this.setParticipantStatus(id, 'reconnecting');
        this.schedulePeerRecovery(id, entry);
        this.scheduleFailedStatus(id, entry, 20000);
      }

      if (pc.iceConnectionState === 'failed') {
        this.setParticipantStatus(id, 'reconnecting');
        this.scheduleFailedStatus(id, entry, 15000);
        void this.restartPeerConnection(id, entry);
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log(
        'ICE GATHERING STATE:',
        id,
        pc.iceGatheringState
      );
    };

    return entry;
  }

  // AUTOMATIC PEER RECOVERY

  private schedulePeerRecovery(
    id: string,
    entry: PeerConnectionEntry
  ): void {
    if (entry.disconnectTimer) return;

    entry.disconnectTimer = setTimeout(() => {
      entry.disconnectTimer = undefined;

      if (
        this.peers.get(id) === entry &&
        entry.pc.iceConnectionState === 'disconnected'
      ) {
        void this.restartPeerConnection(id, entry);
      }
    }, 8000);
  }

  // RESTART ICE CONNECTION

  private async restartPeerConnection(
    id: string,
    entry: PeerConnectionEntry
  ): Promise<void> {

    const pc = entry.pc;

    const isClosed =
      String(pc.connectionState) === 'closed' ||
      String(pc.signalingState) === 'closed';

    if (
      this.peers.get(id) !== entry ||
      isClosed ||
      entry.restartInProgress
    ) {
      return;
    }

    if (pc.signalingState !== 'stable') {
      console.warn(
        'Cannot restart yet; signaling is not stable:',
        id,
        pc.signalingState
      );

      this.setParticipantStatus(id, 'reconnecting');
      this.scheduleFailedStatus(id, entry, 20000);
      return;
    }

    entry.restartInProgress = true;

    try {
      this.setParticipantStatus(id, 'reconnecting');
      this.scheduleFailedStatus(id, entry, 20000);

      pc.restartIce();

      const offer = await pc.createOffer({
        iceRestart: true
      });

      if (this.peers.get(id) !== entry) {
        return;
      }

      await pc.setLocalDescription(offer);

      if (this.peers.get(id) !== entry) {
        return;
      }

      this.socket?.emit('offer', {
        to: id,
        name: this.name,
        description: pc.localDescription
      });

    } catch (error) {
      console.error('ICE RESTART ERROR:', id, error);

      this.scheduleFailedStatus(id, entry, 15000);

    } finally {
      entry.restartInProgress = false;
    }
  }

  // LIMIT OUTGOING VIDEO BITRATE

  private async limitVideoBitrate(
    sender: RTCRtpSender
  ): Promise<void> {
    try {
      const parameters = sender.getParameters();

      if (
        !parameters.encodings ||
        parameters.encodings.length === 0
      ) {
        parameters.encodings = [{}];
      }

      parameters.encodings[0].maxBitrate = 450000;
      parameters.encodings[0].maxFramerate = 24;

      await sender.setParameters(parameters);

    } catch (error) {
      console.warn('Could not set video bitrate:', error);
    }
  }

  // CREATE OFFER

  private async createOffer(
    id: string,
    name: string
  ): Promise<void> {

    try {
      const entry = this.getPeer(id, name);

      if (entry.pc.signalingState !== 'stable') {
        return;
      }

      const offer = await entry.pc.createOffer();

      if (this.peers.get(id) !== entry) {
        return;
      }

      await entry.pc.setLocalDescription(offer);

      if (this.peers.get(id) !== entry) {
        return;
      }

      this.socket?.emit('offer', {
        to: id,
        name: this.name,
        description: entry.pc.localDescription
      });

    } catch (error) {
      console.error('CREATE OFFER ERROR:', error);
    }
  }

  // FLUSH ICE CANDIDATES

  private async flushCandidates(
    id: string,
    pc: RTCPeerConnection
  ): Promise<void> {

    const candidates =
      this.pendingCandidates.get(id) || [];

    this.pendingCandidates.delete(id);

    for (const candidate of candidates) {
      await pc.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    }
  }

  // ADD REMOTE PARTICIPANT

  private addRemoteParticipant(
    id: string,
    name: string,
    stream: MediaStream
  ): void {

    const existing = this.remoteParticipants.find(
      participant => participant.id === id
    );

    if (existing) {
      this.remoteParticipants = this.remoteParticipants.map(
        participant => participant.id === id
          ? {
              ...participant,
              name,
              stream
            }
          : participant
      );
    } else {
      this.remoteParticipants = [
        ...this.remoteParticipants,
        {
          id,
          name,
          stream,
          status: 'connecting'
        }
      ];
    }

    if (!this.activeSpeaker) {
      this.activeSpeaker =
        this.remoteParticipants.find(
          participant => participant.id === id
        );
    }

    this.setupAudioMonitor(id, stream);
  }

  // ACTIVE SPEAKER AUDIO DETECTION

  private setupAudioMonitor(
    id: string,
    stream: MediaStream
  ): void {

    try {
      if (this.audioMonitors.has(id)) return;

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) return;

      if (
        !this.audioContext ||
        this.audioContext.state === 'closed'
      ) {
        this.audioContext = new AudioContext();
      }

      void this.audioContext.resume();

      const source =
        this.audioContext.createMediaStreamSource(stream);

      const analyser =
        this.audioContext.createAnalyser();

      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;

      source.connect(analyser);

      this.audioMonitors.set(id, {
        source,
        analyser
      });

      if (!this.speakerTimer) {
        this.speakerTimer = setInterval(() => {
          this.detectActiveSpeaker();
        }, 300);
      }

    } catch (error) {
      console.warn('Audio detection unavailable:', error);
    }
  }

  private detectActiveSpeaker(): void {
    let loudestId: string | undefined;
    let loudestLevel = 0;

    for (const [id, monitor] of this.audioMonitors) {
      const data = new Uint8Array(
        monitor.analyser.fftSize
      );

      monitor.analyser.getByteTimeDomainData(data);

      let sum = 0;

      for (let i = 0; i < data.length; i++) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }

      const rms = Math.sqrt(sum / data.length);

      if (rms > loudestLevel) {
        loudestLevel = rms;
        loudestId = id;
      }
    }

    if (loudestId && loudestLevel > 0.035) {
      this.lastSpeechTime = Date.now();

      const speaker = this.remoteParticipants.find(
        participant => participant.id === loudestId
      );

      if (
        speaker &&
        this.activeSpeaker?.id !== speaker.id
      ) {
        this.activeSpeaker = speaker;
      }

      return;
    }

    if (
      Date.now() - this.lastSpeechTime > 1800 &&
      this.remoteParticipants.length > 0
    ) {
      if (
        !this.activeSpeaker ||
        !this.remoteParticipants.some(
          participant =>
            participant.id === this.activeSpeaker?.id
        )
      ) {
        this.activeSpeaker = this.remoteParticipants[0];
      }
    }
  }

  private stopSpeakerDetection(): void {
    if (this.speakerTimer) {
      clearInterval(this.speakerTimer);
      this.speakerTimer = undefined;
    }

    this.audioMonitors.forEach(monitor => {
      try {
        monitor.source.disconnect();
        monitor.analyser.disconnect();
      } catch {
        // Already disconnected.
      }
    });

    this.audioMonitors.clear();

    if (this.audioContext) {
      const context = this.audioContext;
      this.audioContext = undefined;

      if (context.state !== 'closed') {
        void context.close().catch(error => {
          console.warn('Audio context cleanup error:', error);
        });
      }
    }

    this.lastSpeechTime = 0;
  }

  // MICROPHONE

  toggleMic(): void {
    this.muted = !this.muted;

    this.localStream
      ?.getAudioTracks()
      .forEach(track => {
        track.enabled = !this.muted;
      });
  }

  // CAMERA ON / OFF

  toggleCamera(): void {
    this.cameraOff = !this.cameraOff;

    this.localStream
      ?.getVideoTracks()
      .forEach(track => {
        track.enabled = !this.cameraOff;
      });

    if (this.localVideo) {
      const video = this.localVideo.nativeElement;

      if (this.cameraOff) {
        video.pause();
      } else {
        void video.play().catch(() => undefined);
      }
    }
  }

  // SWITCH FRONT / BACK CAMERA

  async switchCamera(): Promise<void> {
    const stream = this.localStream;

    if (this.switchingCamera || !stream) return;

    const oldTrack = stream.getVideoTracks()[0];

    if (!oldTrack || oldTrack.readyState !== 'live') {
      this.toast('No active camera found.');
      return;
    }

    this.switchingCamera = true;

    const oldSettings = oldTrack.getSettings();
    const oldDeviceId = oldSettings.deviceId;
    const oldFacing = oldSettings.facingMode ||
      (this.isFrontCamera ? 'user' : 'environment');

    const nextFacing: 'user' | 'environment' =
      oldFacing === 'environment' ? 'user' : 'environment';

    const senders: RTCRtpSender[] = [];

    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find(
        item => item.track?.kind === 'video'
      );

      if (sender) senders.push(sender);
    }

    let newTrack: MediaStreamTrack | undefined;
    let oldTrackStopped = false;
    const replacedSenders: RTCRtpSender[] = [];

    const openCamera = async (
      video: MediaTrackConstraints
    ): Promise<MediaStreamTrack> => {
      const cameraStream =
        await navigator.mediaDevices.getUserMedia({
          audio: false,
          video
        });

      const track = cameraStream.getVideoTracks()[0];

      if (!track) {
        cameraStream.getTracks().forEach(item => item.stop());
        throw new Error('No video track was returned.');
      }

      return track;
    };

    const findOtherCamera = async (): Promise<MediaDeviceInfo | undefined> => {
      const devices =
        await navigator.mediaDevices.enumerateDevices();

      const cameras = devices.filter(
        device => device.kind === 'videoinput'
      );

      return cameras.find(camera =>
        camera.deviceId !== oldDeviceId &&
        camera.label.toLowerCase().includes(
          nextFacing === 'user' ? 'front' : 'back'
        )
      ) || cameras.find(
        camera => camera.deviceId !== oldDeviceId
      );
    };

    const acquireNextCamera = async (): Promise<MediaStreamTrack> => {
      try {
        return await openCamera({
          facingMode: { exact: nextFacing },
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 20, max: 24 }
        });
      } catch (error) {
        console.warn('Exact facing mode failed:', error);
      }

      const otherCamera = await findOtherCamera();

      if (otherCamera) {
        try {
          return await openCamera({
            deviceId: { exact: otherCamera.deviceId },
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 20, max: 24 }
          });
        } catch (error) {
          console.warn('Camera device selection failed:', error);
        }
      }

      return await openCamera({
        facingMode: { ideal: nextFacing },
        width: { ideal: 640, max: 640 },
        height: { ideal: 360, max: 360 },
        frameRate: { ideal: 20, max: 24 }
      });
    };

    const restoreOldCamera = async (): Promise<void> => {
      let restoredTrack: MediaStreamTrack | undefined;

      if (oldDeviceId) {
        try {
          restoredTrack = await openCamera({
            deviceId: { exact: oldDeviceId }
          });
        } catch (error) {
          console.warn('Could not restore old device:', error);
        }
      }

      if (!restoredTrack) {
        try {
          restoredTrack = await openCamera({
            facingMode: { ideal: oldFacing }
          });
        } catch (error) {
          console.error('Could not restore old facing mode:', error);
        }
      }

      if (!restoredTrack) return;

      restoredTrack.enabled = !this.cameraOff;
      stream.addTrack(restoredTrack);

      for (const sender of senders) {
        try {
          await sender.replaceTrack(restoredTrack);
          void this.limitVideoBitrate(sender);
        } catch (error) {
          console.error('Could not restore sender:', error);
        }
      }

      this.updateCameraOrientation(restoredTrack);
      this.lastCameraDeviceId =
        restoredTrack.getSettings().deviceId;

      this.attachLocalPreview();
    };

    try {
      try {
        newTrack = await acquireNextCamera();
      } catch (firstError) {
        console.warn(
          'Could not open the other camera while current camera is active:',
          firstError
        );

        stream.removeTrack(oldTrack);
        oldTrack.stop();
        oldTrackStopped = true;

        await new Promise(resolve => setTimeout(resolve, 350));

        newTrack = await acquireNextCamera();
      }

      newTrack.enabled = !this.cameraOff;

      for (const sender of senders) {
        await sender.replaceTrack(newTrack);
        replacedSenders.push(sender);
        void this.limitVideoBitrate(sender);
      }

      stream.removeTrack(oldTrack);

      if (!oldTrackStopped) {
        oldTrack.stop();
      }

      stream.addTrack(newTrack);

      this.lastCameraDeviceId =
        newTrack.getSettings().deviceId;

      this.updateCameraOrientation(newTrack);
      this.attachLocalPreview();

      this.toast(
        this.isFrontCamera
          ? 'Front camera activated.'
          : 'Rear camera activated.'
      );

    } catch (error) {
      console.error('CAMERA SWITCH ERROR:', error);

      if (!oldTrackStopped && oldTrack.readyState === 'live') {
        for (const sender of replacedSenders) {
          try {
            await sender.replaceTrack(oldTrack);
          } catch (rollbackError) {
            console.error('Camera rollback failed:', rollbackError);
          }
        }

        newTrack?.stop();
      } else {
        newTrack?.stop();
        await restoreOldCamera();
      }

      this.toast('Could not switch camera. Please try again.');

    } finally {
      this.switchingCamera = false;
    }
  }

  // COPY MEETING CODE

  async copyRoom(): Promise<void> {
    if (!this.roomId) return;

    try {
      await navigator.clipboard.writeText(this.roomId);
      this.toast('Meeting code copied.');
    } catch {
      this.toast('Meeting code: ' + this.roomId);
    }
  }

  // LEAVE MEETING

  leaveRoom(): void {
    this.stopBackgroundCallService();
    this.stopCallDuration();

    this.socket?.emit('leave-room');

    for (const id of Array.from(this.peers.keys())) {
      this.closePeer(id);
    }

    this.stopSpeakerDetection();

    this.remoteParticipants = [];
    this.activeSpeaker = undefined;
    this.participants = [];

    this.pendingCandidates.clear();

    this.stopLocalMedia();

    this.meet.disconnect();
    this.socket = undefined;

    this.joined = false;
    this.connecting = false;
    this.roomId = '';

    this.muted = false;
    this.cameraOff = false;
    this.switchingCamera = false;
    this.isFrontCamera = true;

    this.lastCameraDeviceId = undefined;
    this.lastSocketId = undefined;
    this.resumingConnection = false;

    this.resetLocalVideoPosition();
  }

  // CLOSE PEER

  private closePeer(id: string): void {
    const entry = this.peers.get(id);

    if (entry) {
      this.clearPeerDisconnectTimer(entry);
      this.clearPeerStatusTimer(entry);

      const pc = entry.pc;

      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onnegotiationneeded = null;

      pc.close();
    }

    this.peers.delete(id);
    this.pendingCandidates.delete(id);

    const monitor = this.audioMonitors.get(id);

    if (monitor) {
      try {
        monitor.source.disconnect();
        monitor.analyser.disconnect();
      } catch {
        // Already disconnected.
      }

      this.audioMonitors.delete(id);
    }

    if (this.audioMonitors.size === 0) {
      if (this.speakerTimer) {
        clearInterval(this.speakerTimer);
        this.speakerTimer = undefined;
      }

      if (this.audioContext) {
        const context = this.audioContext;
        this.audioContext = undefined;

        if (context.state !== 'closed') {
          void context.close().catch(error => {
            console.warn('Audio context cleanup error:', error);
          });
        }
      }
    }

    this.remoteParticipants =
      this.remoteParticipants.filter(
        participant => participant.id !== id
      );

    if (this.activeSpeaker?.id === id) {
      this.activeSpeaker = this.remoteParticipants[0];
    }
  }

  // STOP LOCAL CAMERA AND MICROPHONE

  private stopLocalMedia(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        track.stop();
      });

      this.localStream = undefined;
    }

    this.lastCameraDeviceId = undefined;

    if (this.localVideo) {
      const video = this.localVideo.nativeElement;
      video.pause();
      video.srcObject = null;
    }
  }

  // SHOW MESSAGE

  private toast(message: string): void {
    this.toastMessage = message;
  }

  // COMPONENT CLEANUP

  ngOnDestroy(): void {
    void this.backButtonListener?.remove().catch(error => {
      console.warn('Could not remove Android Back handler:', error);
    });

    this.backButtonListener = undefined;

    this.leaveRoom();
  }
}
