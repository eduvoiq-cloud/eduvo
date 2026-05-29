interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
}

export default function StatCard({ label, value, sub, icon }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
        </div>
        {icon && (
          <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
