export interface QRCodeData {
  qrCode: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
}

export interface SessionData {
  isConnected: boolean;
  phoneNumber?: string;
}

export interface ConnectionInfo {
  phoneNumber: string;
  platform: string;
  device: string;
  browser: string[];
  passive: boolean;
  connectedAt: Date;
  deviceInfo?: {
    os: string;
    appVersion: string;
    deviceType: string;
  };
}
