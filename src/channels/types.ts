export type RoutingHint = 'simple' | 'complex' | 'vision' | 'creative';

export type IncomingAttachment = {
  type:       'document' | 'audio' | 'video' | 'voice' | 'sticker';
  file_id?:   string;
  filename?:  string;
  mime_type?: string;
  caption?:   string;
  file_path?: string;
};

export type UtterancePayload = {
  text:          string;
  confidence?:   number;
  image_b64?:    string | null;
  images_b64?:   string[];      // multiple images sent together
  attachments?:  IncomingAttachment[];
  routing_hint?: RoutingHint;
  context?: { battery?: number; activity?: string; time_of_day?: string };
};

export type GatewayEvent = {
  type:       'event';
  event:      'utterance';
  node_id:    string;
  session_id: string;
  ts:         number;
  payload:    UtterancePayload;
};

export type GatewayCommand = {
  type:    'command';
  target:  string;
  cmd:     'speak' | 'display';
  payload: { text: string; voice?: string; display?: string };
};

export type CommandCallback = (node_id: string, cmd: string, payload: unknown) => void;
