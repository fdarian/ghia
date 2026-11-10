/** A macOS frosted-glass window using GPUI's native blurred backdrop. */

import { render } from '@ghia/react'

const glass = {
  display: 'flex' as const,
  flexDirection: 'column' as const,
  backgroundColor: '#FFFFFF0D',
  borderWidth: 1,
  borderColor: '#FFFFFF1F',
  borderStyle: 'solid',
  borderRadius: 16,
}

const muted = '#FFFFFF99'

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ ...glass, flexGrow: 1, gap: 7, padding: 16 }}>
      <div style={{ color: muted, fontSize: 12 }}>{label}</div>
      <div style={{ color: '#FFFFFF', fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  )
}

function App() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0A101826',
      }}
    >
      {/* Clear of the traffic lights; the window has no titlebar of its own to move it by. */}
      <div style={{ height: 58, flexShrink: 0, appRegion: 'drag' }} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          padding: 22,
          paddingTop: 0,
          gap: 18,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ gap: 5 }}>
            <div style={{ color: muted, fontSize: 12, fontWeight: 600 }}>SUNDAY, AUGUST 30</div>
            <div style={{ color: '#FFFFFF', fontSize: 30, fontWeight: 650 }}>Good morning, Tommy</div>
          </div>
          <div
            style={{
              ...glass,
              paddingTop: 9,
              paddingBottom: 9,
              paddingLeft: 14,
              paddingRight: 14,
            }}
          >
            <div style={{ color: '#FFFFFFCC', fontSize: 13 }}>Cupertino · 21°</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'row', gap: 12 }}>
          <Metric label="FOCUS TIME" value="3h 24m" />
          <Metric label="TASKS DONE" value="8 / 11" />
          <Metric label="ENERGY" value="High" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, gap: 14 }}>
          <div style={{ ...glass, flexGrow: 1, padding: 20, gap: 18 }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ gap: 4 }}>
                <div style={{ color: '#FFFFFF', fontSize: 18, fontWeight: 600 }}>Today</div>
                <div style={{ color: muted, fontSize: 13 }}>A light plan for a quiet Sunday</div>
              </div>
              <div style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: '#79E6B3' }} />
            </div>

            {[
              ['09:30', 'Review the GPUI window API'],
              ['11:00', 'Build the glass example'],
              ['14:30', 'Walk and reset'],
            ].map(([time, task], index) => (
              <div
                key={task}
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 48, color: '#FFFFFF73', fontSize: 12 }}>{time}</div>
                  <div style={{ color: '#FFFFFFE8', fontSize: 14 }}>{task}</div>
                </div>
                {index < 2 && <div style={{ height: 1, backgroundColor: '#FFFFFF17' }} />}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', width: 220, gap: 14 }}>
            <div style={{ ...glass, flexGrow: 1, padding: 18, justifyContent: 'space-between' }}>
              <div style={{ gap: 5 }}>
                <div style={{ color: muted, fontSize: 12, fontWeight: 600 }}>NOW PLAYING</div>
                <div style={{ color: '#FFFFFF', fontSize: 18, fontWeight: 600 }}>Soft Focus</div>
                <div style={{ color: '#FFFFFF80', fontSize: 13 }}>Leavv</div>
              </div>
              <div style={{ gap: 8 }}>
                <div style={{ height: 3, borderRadius: 2, backgroundColor: '#FFFFFF29' }}>
                  <div style={{ width: '62%', height: '100%', borderRadius: 2, backgroundColor: '#FFFFFFD9' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between' }}>
                  <div style={{ color: '#FFFFFF70', fontSize: 11 }}>2:08</div>
                  <div style={{ color: '#FFFFFF70', fontSize: 11 }}>3:24</div>
                </div>
              </div>
            </div>

            <div style={{ ...glass, padding: 18, gap: 7 }}>
              <div style={{ color: muted, fontSize: 12, fontWeight: 600 }}>INTENTION</div>
              <div style={{ color: '#FFFFFFE8', fontSize: 14, lineHeight: "21px" }}>
                Make one thing clear and useful.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

render(<App />, {
  title: 'GPUIX Blurred Window',
  appName: 'GPUIX Blurred Window',
  width: 760,
  height: 510,
  minWidth: 640,
  minHeight: 440,
  titlebarTransparent: true,
  windowBackground: 'blurred',
  trafficLightX: 18,
  trafficLightY: 18,
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
