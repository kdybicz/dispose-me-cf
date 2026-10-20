CREATE TABLE messages (
  Id TEXT NOT NULL,
  Username TEXT NOT NULL,
  Sender TEXT NOT NULL,
  Subject TEXT NOT NULL,
  ReceivedAt INTEGER NOT NULL,
  ExpireAt INTEGER NOT NULL,
  HasAttachments INTEGER NOT NULL CHECK (HasAttachments IN (0, 1)),
  PRIMARY KEY (Username, Id)
);

CREATE INDEX messages_inbox_received ON messages (Username, ReceivedAt DESC, Id DESC);
CREATE INDEX messages_expiration ON messages (ExpireAt);
