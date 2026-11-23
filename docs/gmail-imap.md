# Gmail with a Mutt-style home config

Plainpost's default uses `imap.gmail.com:993` with TLS, and `smtp.gmail.com:465` with TLS. Port 587 with required STARTTLS is also supported. It follows [NeoMutt's Gmail setup](https://docs.neomutt.org/tutorials/gmail-setup.html) without requiring a Google Cloud project.

## Prepare Google Account

Enable **2-Step Verification**, then [create an app password](https://myaccount.google.com/apppasswords) named Plainpost. Use the 16-character app password, never your normal Google password. Google may hide this option for security-key-only verification, organizational accounts, and Advanced Protection. Check [Google's instructions](https://support.google.com/accounts/answer/185833); do not weaken account protections to bypass a policy. The optional OAuth flow remains available in settings.

Personal Gmail IMAP is always enabled, so no Enable IMAP toggle is needed. [Google's IMAP guidance](https://support.google.com/mail/answer/7126229). Ensure All Mail, Drafts and Trash are visible to IMAP in Gmail's label settings.

## Create the config on the server machine

Run inside the project in **WSL**, or on the **ARM64 board**:

```sh
npm run config:init
nano ~/.config/plainpost/mail.conf
chmod 600 ~/.config/plainpost/mail.conf
```

The initializer creates a sample with mode 600 and never overwrites an existing file. Replace the address and password:

```muttrc
set imap_user = "your-account@gmail.com"
set folder = "imaps://imap.gmail.com/"
set imap_pass = "abcdefghijklmnop" # replace this example with the app password
set smtp_url = "smtps://smtp.gmail.com:465/"
set smtp_pass = $imap_pass
set from = "Your Name <your-account@gmail.com>"
```

Google displays the app password with spaces; either keep them inside quotes or remove them. A Gmail-approved sender alias is allowed in `from`; both server logins must use the same account. For STARTTLS, change `smtp_url` to `smtp://smtp.gmail.com:587/`. TLS certificate validation is always enabled.

Open **settings → Reload config & connect**. Plainpost tests both logins without sending mail. Files are reread for each operation; no restart is needed. The GUI shows the actual server-side config path and actionable setup errors, never the password. Use the home directory of the account running Plainpost. Windows browsers and SSH-forwarded laptops do not supply the server's HOME.

## Reuse a Mutt config

Skip `config:init` to reuse an existing static config. Lookup order:

1. `PLAINPOST_MAIL_CONFIG`, if explicitly set (no fallback).
2. `$XDG_CONFIG_HOME/plainpost/mail.conf`, default `~/.config/plainpost/mail.conf`.
3. `~/.muttrc`.
4. `~/.config/mutt/muttrc`.
5. `~/.neomuttrc`.
6. `~/.config/neomutt/neomuttrc`.

The first existing file is used. On Linux, every config, static `source` file and password file must belong to the server user and have mode 600 or stricter. Use Linux home storage in WSL rather than `/mnt/c` for these private files.

Supported: static `set` values, quoted strings, references to earlier variables such as `$imap_user`, `$imap_pass` and `my_` variables, `$HOME`, and static `source` paths. Unrelated Mutt display options are ignored. Hooks, account-switching logic, shell commands, backticks and GPG/source pipes are not executed. If your Mutt config needs those features, create a dedicated static Plainpost config. This parser is not a Mutt interpreter.

For a separate password file, remove `imap_pass` and `smtp_pass` and use:

```muttrc
set imap_pass_file = "~/.config/plainpost/gmail-app-password"
```

Put only the app password in that file and apply `chmod 600`. `smtp_pass_file` can override SMTP's password; otherwise SMTP reuses IMAP's password. These two `*_pass_file` settings are Plainpost extensions, not Mutt options. The app does not execute a command to retrieve credentials.

## Mail behavior and troubleshooting

Gmail conversation IDs and search operators use [Google's IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions). Draft updates append a replacement, then remove the superseded draft. Sending removes only the sent draft; mailbox Trash actions move messages instead of permanently expunging conversations. Gmail records SMTP mail in Sent, so Plainpost avoids creating a duplicate Sent copy.

Message downloads are capped at 8 MiB; threads at 24 MiB and 1,000 messages. Searches show up to 30 conversations per page. After 1,000 distinct conversations, narrow the list/date range. Thread trees still follow RFC822 reply headers. HTML is hidden and outgoing MIME is always plain text, with Bcc in the SMTP envelope but absent from delivered headers.

An interrupted send is never automatically retried. Check Sent before trying again. If SMTP succeeded but deleting its draft failed, the UI says it was sent and warns against resending. Deduplication survives repeated clicks during this server process but not crashes.

**Disconnect** removes local sessions and leaves your config in place. Revoke the app password in Google Account to disable it. Changing your normal Google password also revokes existing app passwords; create a replacement and update the file. Credentials remain in private server-side files, not browser storage or the encrypted session vault.

This is Gmail-specific IMAP support. Real login, SMTP delivery, account policies and sender aliases must be verified with your account; automated tests use mocked servers and never send real mail.
