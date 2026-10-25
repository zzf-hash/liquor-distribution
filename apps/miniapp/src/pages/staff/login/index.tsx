import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { ROLE_HOME_PAGE, authApi, saveSession } from '../../../services/api'
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

  async function submit() {
    if (submitting) return
    if (!username.trim() || !password) {
      Taro.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const res = await authApi.login(username.trim(), password, tenantCode)
      const role = res.user?.role ?? ''
      const home = ROLE_HOME_PAGE[role]
      if (!home) {
        Taro.showToast({ title: `未知角色 ${role}，请联系管理员`, icon: 'none' })
        return
      }
      saveSession(res)
      Taro.showToast({ title: `欢迎，${res.user.name}（${ROLE_NAME[role] ?? role}）`, icon: 'none' })
      // CUSTOMER 首页是 tabBar 页须 switchTab；员工端首页 reLaunch 清栈
      if (role === 'CUSTOMER') Taro.switchTab({ url: home })
      else Taro.reLaunch({ url: home })
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '登录失败', icon: 'none' })
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
          className='ipt'
          placeholder='租户编码（同名账号时必填）'
          value={tenantCode}
          onInput={(e) => setTenantCode(e.detail.value)}
        />
        <Input
          className='ipt'
          placeholder='账号'
          value={username}
          onInput={(e) => setUsername(e.detail.value)}
        />
        <Input
          className='ipt'
          password
          placeholder='密码'
          value={password}
          onInput={(e) => setPassword(e.detail.value)}
        />
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
