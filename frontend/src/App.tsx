import { Route, Routes } from "react-router-dom";

import { Layout } from "@/components/layout/Layout";
import { ProtectedRoute } from "@/components/layout/ProtectedRoute";
import AIAgentLogs from "@/pages/AIAgentLogs";
import AIDocumentation from "@/pages/AIDocumentation";
import AIAgentsList from "@/pages/AIAgentsList";
import AIApprovals from "@/pages/AIApprovals";
import AIMemory from "@/pages/AIMemory";
import AIChat from "@/pages/AIChat";
import AIDashboard from "@/pages/AIDashboard";
import AISettings from "@/pages/AISettings";
import AITasks from "@/pages/AITasks";
import Alerts from "@/pages/Alerts";
import AppCatalog from "@/pages/AppCatalog";
import PlaybookLibrary from "@/pages/PlaybookLibrary";
import Automation from "@/pages/Automation";
import Cameras from "@/pages/Cameras";
import CameraWallboard from "@/pages/CameraWallboard";
import Cluster from "@/pages/Cluster";
import ContainerDetail from "@/pages/ContainerDetail";
import AllContainers from "@/pages/AllContainers";
import Containers from "@/pages/Containers";
import DockerHostDetail from "@/pages/DockerHostDetail";
import HostMetricsDetail from "@/pages/HostMetricsDetail";
import JobDetail from "@/pages/JobDetail";
import Jobs from "@/pages/Jobs";
import Login from "@/pages/Login";
import Logs from "@/pages/Logs";
import Monitoring from "@/pages/Monitoring";
import OpsFloor from "@/pages/OpsFloor";
import Overview from "@/pages/Overview";
import PatchReports from "@/pages/PatchReports";
import Patching from "@/pages/Patching";
import Registries from "@/pages/Registries";
import SecurityIntelligence from "@/pages/SecurityIntelligence";
import ServerDetail from "@/pages/ServerDetail";
import Servers from "@/pages/Servers";
import Services from "@/pages/Services";
import SettingsPage from "@/pages/Settings";
import StackDetail from "@/pages/StackDetail";
import TrafficMapPage from "@/pages/TrafficMapPage";
import Vpn from "@/pages/Vpn";
import Vulnerabilities from "@/pages/Vulnerabilities";
import Wallboard from "@/pages/Wallboard";

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route element={<ProtectedRoute />}>
        {/* No sidebar/chrome - meant to be opened fullscreen on a wall-mounted monitor */}
        <Route path="wallboard" element={<Wallboard />} />
        <Route path="cameras/wallboard" element={<CameraWallboard />} />
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="servers" element={<Servers />} />
          <Route path="servers/:id" element={<ServerDetail />} />
          <Route path="services" element={<Services />} />
          <Route path="monitoring" element={<Monitoring />} />
          <Route path="monitoring/:hostname" element={<HostMetricsDetail />} />
          <Route path="traffic-map" element={<TrafficMapPage />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="cameras" element={<Cameras />} />
          <Route path="patching" element={<Patching />} />
          <Route path="patching/reports" element={<PatchReports />} />
          <Route path="vulnerabilities" element={<Vulnerabilities />} />
          <Route path="security-intelligence" element={<SecurityIntelligence />} />
          <Route path="automation" element={<Automation />} />
          <Route path="automation/playbooks" element={<PlaybookLibrary />} />
          <Route path="ai-agents" element={<AIDashboard />} />
          <Route path="ai-agents/documentation" element={<AIDocumentation />} />
          <Route path="ai-agents/chat" element={<AIChat />} />
          <Route path="ai-agents/memory" element={<AIMemory />} />
          <Route path="ai-agents/agents" element={<AIAgentsList />} />
          <Route path="ai-agents/ops-floor" element={<OpsFloor />} />
          <Route path="ai-agents/tasks" element={<AITasks />} />
          <Route path="ai-agents/approvals" element={<AIApprovals />} />
          <Route path="ai-agents/agent-logs" element={<AIAgentLogs />} />
          <Route path="ai-agents/settings" element={<AISettings />} />
          <Route path="containers" element={<Containers />} />
          <Route path="containers/all" element={<AllContainers />} />
          <Route path="registries" element={<Registries />} />
          <Route path="app-catalog" element={<AppCatalog />} />
          <Route path="containers/:hostname" element={<DockerHostDetail />} />
          <Route path="containers/:hostname/stacks/:name" element={<StackDetail />} />
          <Route path="containers/:hostname/:name" element={<ContainerDetail />} />
          <Route path="logs" element={<Logs />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="jobs/:id" element={<JobDetail />} />
          <Route path="cluster" element={<Cluster />} />
          <Route path="vpn" element={<Vpn />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
