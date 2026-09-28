import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { authApi, saveSession } from '../../../services/api'
import './index.scss'

/**
 * 员工登录（内勤/老板/业务员/仓配统一入口）：
 * - REP → 拜访打卡页（语音报单从打卡页后续任务接线）
 * - OWNER/CLERK/WAREHOUSE → 小程序端暂未开放管理页面，登录保留会话并提示用 Web 后台
 * - CUSTOMER 角色 → 拒绝，引导回首页客户订货通道
 */
const STAFF_ROLE_NAME: Record<string, string> = {
  OWNER: '老板',
  CLERK: '内勤',
  REP: '业务员',
  WAREHOUSE: '仓配',
}

export default function StaffLoginPage() {
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
      const res = await authApi.login(username.trim(), password)
      const role = res.user?.role ?? ''
      if (role === 'CUSTOMER') {
        Taro.showToast({ title: '客户账号请返回首页，走「文字下单」通道', icon: 'none' })
        return
      }
      saveSession(res)
      const roleName = STAFF_ROLE_NAME[role] ?? role
      if (role === 'REP') {
        Taro.showToast({ title: `欢迎，${res.user.name}（${roleName}）`, icon: 'none' })
        Taro.navigateTo({ url: '/pages/salesman/visit/index' })
      } else {
        Taro.showModal({
          title: `欢迎，${res.user.name}（${roleName}）`,
          content:
            '内勤/老板管理后台请在电脑浏览器打开：http://43.134.86.167（账号密码相同）。小程序端管理页面将在后续版本开放。',
          showCancel: false,
        })
      }
    } catch (e) {
      Taro.showToast({ title: e instanceof Error ? e.message : '登录失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='login'>
      <View className='login__hd'>
        <Text className='login__title'>员工登录</Text>
        <Text className='login__sub'>业务员/内勤/老板工作入口</Text>
      </View>

      <View className='login__form'>
        <Input
          className='ipt'
          placeholder='员工账号'
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
        <Text className='login__tip'>演示：owner / clerk / rep1　密码：demo1234</Text>
        <Text className='login__tip'>管理后台（电脑浏览器）：http://43.134.86.167</Text>
      </View>
    </View>
  )
}
