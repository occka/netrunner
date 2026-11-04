-- NEURAL agent: per-chat mode, attachments kept in context, photos and tool actions on messages.
ALTER TABLE neural_chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'work';
ALTER TABLE neural_chats ADD COLUMN kept_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE neural_messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE neural_messages ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]';
