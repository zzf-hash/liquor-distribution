import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { APP_ROLE } from '../../../config/app-role'
import { ROLE_HOME_PAGE, authApi, clearSession, saveSession } from '../../../services/api'
import { openAppPage } from '../../../services/navigation'
import { loginBlock } from '../../../services/package-login-gate'
import './index.scss'

/**
 * 统一登录（P1 全员端）：五角色一个入口，账密登录后按 user.role 自动跳对应首页
 *   CUSTOMER→客户端订货 / REP→业务员宫格 / WAREHOUSE→拣货工作台
 *   CLERK→订单池 / OWNER→四问看板
 * （路由表=services/api.ts ROLE_HOME_PAGE；token 沿用 ld_token，微信授权登录后续版本接入）
 */
const ROLE_NAME: Record<string, string> = {
  OWNER: '老板',
  CLERK: '内勤',
  REP: '业务员',
  WAREHOUSE: '仓配',
  CUSTOMER: '客户',
}

export default function StaffLoginPage() {
  const [tenantCode, setTenantCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [focus, setFocus] = useState('')

  async function submit() {
    if (submitting) return
    if (!username.trim() || !password) {
      setError('请输入账号和密码')
      Taro.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const res = await authApi.login(username.trim(), password, tenantCode)
      const role = res.user?.role ?? ''
      // 员工包没有客户原生 tab。客户账号停在本页，不写会话；和客户登录页拒绝员工账号同一套门闩。
      const block = loginBlock(APP_ROLE, role, 'staff')
      if (block) {
        if (block.clearSession) clearSession()
        Taro.showToast({ title: block.toast, icon: 'none' })
        return
      }
      const home = ROLE_HOME_PAGE[role]
      if (!home) {
        Taro.showToast({ title: `未知角色 ${role}，请联系管理员`, icon: 'none' })
        return
      }
      saveSession(res)
      Taro.showToast({ title: `欢迎，${res.user.name}（${ROLE_NAME[role] ?? role}）`, icon: 'none' })
      // 客户首页在客户包里是 tab 页；员工首页用 reLaunch 清栈。openAppPage 按编译期 tab 选择。
      if (role === 'CUSTOMER') openAppPage(home)
      else Taro.reLaunch({ url: home })
    } catch (e) {
      const message = e instanceof Error ? e.message : '登录失败'
      setError(message)
      Taro.showToast({ title: message, icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='login'>
      <View className='login__hd'>
        <Text className='login__title'>统一登录</Text>
        <Text className='login__sub'>老板 / 内勤 / 业务员 / 仓配 / 客户，一个入口</Text>
      </View>

      <View className='login__form'>
        <Input
          className={`ipt ${focus === 'tenant' ? 'ipt--focus' : ''} ${error ? 'ipt--error' : ''}`}
          placeholder='租户编码（同名账号时必填）'
          value={tenantCode}
          onFocus={() => setFocus('tenant')}
          onBlur={() => setFocus('')}
          onInput={(e) => setTenantCode(e.detail.value)}
        />
        <Input
          className={`ipt ${focus === 'user' ? 'ipt--focus' : ''} ${error ? 'ipt--error' : ''}`}
          placeholder='账号'
          value={username}
          onFocus={() => setFocus('user')}
          onBlur={() => setFocus('')}
          onInput={(e) => setUsername(e.detail.value)}
        />
        <Input
          className={`ipt ${focus === 'pass' ? 'ipt--focus' : ''} ${error ? 'ipt--error' : ''}`}
          password
          placeholder='密码'
          value={password}
          onFocus={() => setFocus('pass')}
          onBlur={() => setFocus('')}
          onInput={(e) => setPassword(e.detail.value)}
        />
        {error ? <Text className='ipt-error'>{error}</Text> : null}
        <Button
          className='btn-primary'
          loading={submitting}
          disabled={submitting}
          onClick={() => { void submit() }}
        >
          登 录
        </Button>
      </View>

      <View className='login__demo'>
        <Text className='login__demo-tip'>账号密码由管理员分发（正式微信授权登录后续版本接入）</Text>
      </View>
    </View>
  )
}
