-- Private, rebuildable parsed-message generations. Raw MIME and inbox keys are unchanged.
CREATE TABLE email_derivatives (
  Id TEXT NOT NULL,
  Version INTEGER NOT NULL,
  Generation TEXT NOT NULL,
  ExpireAt INTEGER NOT NULL,
  Ready INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (Id, Version, Generation)
);

CREATE INDEX email_derivatives_ready ON email_derivatives (Id, Version, Ready, ExpireAt);
CREATE INDEX email_derivatives_expiry ON email_derivatives (ExpireAt);
