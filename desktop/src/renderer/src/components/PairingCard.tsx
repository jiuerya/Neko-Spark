import { useEffect, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { AppStatus } from '@shared/types'

interface PairingCardProps {
  status: AppStatus | null
}

/** 设备配对入口集中放在设备页，避免把连接手机的操作藏在通用设置里。 */
export default function PairingCard({ status }: PairingCardProps): JSX.Element {
  const [activeStatus, setActiveStatus] = useState<AppStatus | null>(status)
  const [pairingQr, setPairingQr] = useState('')

  useEffect(() => setActiveStatus(status), [status])

  const pairingAddress = activeStatus?.hub.addresses[0] ?? ''
  const pairingCode = activeStatus?.hub.pairingCode ?? ''
  const pairingLink = pairingAddress && pairingCode
    ? (() => {
        const link = new URL('neko-spark://pair')
        link.searchParams.set('url', pairingAddress)
        link.searchParams.set('fingerprint', activeStatus?.hubCertFingerprint ?? '')
        link.searchParams.set('code', pairingCode)
        return link.toString()
      })()
    : ''

  useEffect(() => {
    let alive = true
    if (!pairingLink) {
      setPairingQr('')
      return () => {
        alive = false
      }
    }
    void QRCode.toDataURL(pairingLink, { width: 340, margin: 3, errorCorrectionLevel: 'L' })
      .then((dataUrl) => {
        if (alive) setPairingQr(dataUrl)
      })
      .catch(() => {
        if (alive) setPairingQr('')
      })
    return () => {
      alive = false
    }
  }, [pairingLink])

  const refreshPairingCode = async (): Promise<void> => {
    const next = await window.gm.refreshPairingCode()
    setActiveStatus(next)
  }

  return (
    <section className="card span-2 pairing-card">
      <div className="card-head">
        <div>
          <h2>手机配对</h2>
          <p className="card-subtitle">扫码或输入配对码，手机会自动保存 HTTPS 地址、证书指纹和访问密钥。</p>
        </div>
        <button type="button" className="btn" onClick={() => void refreshPairingCode()}>
          刷新配对码
        </button>
      </div>
      <div className="pairing-panel">
        {pairingQr ? <img className="pairing-qr" src={pairingQr} alt="手机扫描配对二维码" /> : null}
        <div className="pairing-details">
          <span className="pairing-label">一次性配对码</span>
          <strong className="pairing-code">{pairingCode || '初始化中...'}</strong>
          <span className="hint">
            手机端可以点“扫一扫配对”，也可以先搜索电脑后输入这个 6 位数字。二维码只含局域网地址、证书指纹和一次性配对码。
          </span>
          {activeStatus?.hub.pairingExpiresAt ? (
            <span className="hint">有效期至 {new Date(activeStatus.hub.pairingExpiresAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
      </div>
    </section>
  )
}
