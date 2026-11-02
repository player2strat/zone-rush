// =============================================================================
// Foray — GMAlertSettings
//
// Two small switches for the GM alerts in lib/gmAlerts: the chime, and desktop
// pop-ups (the first click asks the browser for permission). Shown on the home
// screen's running-games list and on the GM dashboard.
// =============================================================================

import { useState } from 'react'
import {
  popupState, requestPopups, setPopupsOn, setSoundOn, soundOn, type PopupState,
} from '../lib/gmAlerts'

export default function GMAlertSettings() {
  const [sound, setSound] = useState(soundOn)
  const [popups, setPopups] = useState<PopupState>(popupState)

  const toggleSound = () => {
    setSoundOn(!sound)
    setSound(!sound)
  }

  const togglePopups = async () => {
    if (popups === 'ask') {
      setPopups(await requestPopups())
    } else if (popups === 'on' || popups === 'off') {
      setPopupsOn(popups === 'off')
      setPopups(popups === 'off' ? 'on' : 'off')
    }
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <button onClick={toggleSound} style={switchStyle(sound)} title="A short chime when something new comes in">
        Sound {sound ? 'on' : 'off'}
      </button>
      {popups !== 'unsupported' && (
        popups === 'blocked' ? (
          <span style={{ ...switchStyle(false), cursor: 'default' }} title="Allow notifications for this site in your browser settings">
            Pop-ups blocked
          </span>
        ) : (
          <button onClick={togglePopups} style={switchStyle(popups === 'on')} title="Desktop pop-ups when something new comes in">
            {popups === 'ask' ? 'Turn on pop-ups' : `Pop-ups ${popups}`}
          </button>
        )
      )}
    </span>
  )
}

function switchStyle(on: boolean): React.CSSProperties {
  return {
    background: on ? 'rgba(var(--green-rgb), 0.12)' : 'rgba(var(--ink-rgb), 0.04)',
    border: '1px solid ' + (on ? 'rgba(var(--green-rgb), 0.3)' : 'var(--line)'),
    color: on ? 'var(--green)' : 'var(--ink-muted)',
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: '0.7rem',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }
}
